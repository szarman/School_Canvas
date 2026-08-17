"""Two interchangeable ways to read the Canvas REST API.

TokenClient is the fast path: a personal access token and plain HTTP.
BrowserClient is the fallback for districts that disable student tokens --
Selenium signs in, then navigates to the same /api/v1 URLs and reads the
JSON straight out of the page. Both expose get_all(path, **params).
"""

import json
import re
import time

import requests

import config

PER_PAGE = 100
# Canvas prefixes JSON responses with this to defeat JSON hijacking.
JSON_PREFIX = re.compile(r"^\s*while\s*\(1\)\s*;")


class CanvasError(RuntimeError):
    pass


class TokenClient:
    label = "access token"

    def __init__(self, base_url, token):
        self.base_url = base_url
        self.session = requests.Session()
        self.session.headers.update(
            {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        )

    def get_all(self, path, **params):
        """Follow Canvas's Link-header pagination to the end."""
        url = f"{self.base_url}{path}"
        params = {**params, "per_page": PER_PAGE}
        results = []
        while url:
            response = self.session.get(url, params=params, timeout=30)
            if response.status_code in (401, 403):
                raise CanvasError(f"{response.status_code} from {path}: token rejected")
            response.raise_for_status()
            payload = response.json()
            results.extend(payload if isinstance(payload, list) else [payload])
            url = response.links.get("next", {}).get("url")
            params = {}  # the next URL already carries them
        return results

    def close(self):
        self.session.close()


class BrowserClient:
    label = "browser login"

    def __init__(self, base_url, username, password):
        self.base_url = base_url
        self.driver = self._start_driver()
        self._login(username, password)

    @staticmethod
    def _start_driver():
        from selenium import webdriver
        from selenium.webdriver.chrome.service import Service
        from webdriver_manager.chrome import ChromeDriverManager

        options = webdriver.ChromeOptions()
        options.add_argument("--headless=new")
        options.add_argument("--window-size=1280,1024")
        options.add_argument("--log-level=3")
        options.add_experimental_option("excludeSwitches", ["enable-logging"])
        return webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)

    def _login(self, username, password):
        from selenium.webdriver.common.by import By
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait

        self.driver.get(f"{self.base_url}/login/canvas")
        wait = WebDriverWait(self.driver, 30)
        field = wait.until(EC.presence_of_element_located((By.ID, "pseudonym_session_unique_id")))
        field.send_keys(username)

        password_field = self.driver.find_element(By.ID, "pseudonym_session_password")
        password_field.send_keys(password)
        password_field.send_keys(Keys.RETURN)

        # The login page is gone once we land anywhere else.
        wait.until_not(EC.presence_of_element_located((By.ID, "pseudonym_session_password")))
        time.sleep(1)

        probe = self._fetch_json("/api/v1/users/self")
        if not isinstance(probe, dict) or "id" not in probe:
            raise CanvasError("Signed in, but the API did not return a user. Check the password.")

    def _fetch_json(self, path_with_query):
        self.driver.get(f"{self.base_url}{path_with_query}")
        # Chrome wraps a raw JSON body in <pre>; fall back to the whole body.
        from selenium.webdriver.common.by import By

        try:
            text = self.driver.find_element(By.TAG_NAME, "pre").text
        except Exception:
            text = self.driver.find_element(By.TAG_NAME, "body").text
        text = JSON_PREFIX.sub("", text).strip()
        if not text:
            raise CanvasError(f"Empty response from {path_with_query}")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise CanvasError(f"Non-JSON response from {path_with_query}: {text[:120]}") from exc

    def get_all(self, path, **params):
        """No Link headers are visible here, so page until a short page arrives."""
        results = []
        page = 1
        while True:
            query = {**params, "per_page": PER_PAGE, "page": page}
            payload = self._fetch_json(f"{path}?{_encode(query)}")
            batch = payload if isinstance(payload, list) else [payload]
            results.extend(batch)
            if not isinstance(payload, list) or len(batch) < PER_PAGE:
                return results
            page += 1

    def close(self):
        try:
            self.driver.quit()
        except Exception:
            pass


def _encode(params):
    from urllib.parse import urlencode

    # Canvas uses repeated include[] keys, so flatten lists rather than
    # letting urlencode stringify them.
    pairs = []
    for key, value in params.items():
        if isinstance(value, (list, tuple)):
            pairs.extend((key, item) for item in value)
        else:
            pairs.append((key, value))
    return urlencode(pairs)


def connect():
    """Prefer the token; fall back to the browser if it is absent or rejected."""
    config.validate()

    if config.TOKEN:
        client = TokenClient(config.BASE_URL, config.TOKEN)
        try:
            client.get_all("/api/v1/users/self")
            return client
        except CanvasError as exc:
            client.close()
            if not (config.USERNAME and config.PASSWORD):
                raise SystemExit(
                    f"Canvas rejected the access token ({exc}) and no username/password "
                    "is configured to fall back to."
                )
            print(f"  token rejected ({exc}); falling back to browser login")

    return BrowserClient(config.BASE_URL, config.USERNAME, config.PASSWORD)

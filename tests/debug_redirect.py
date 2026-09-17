"""Debug: confirm whether _deny is reached."""
import importlib.util, urllib.request, socket, threading, http.server
spec = importlib.util.spec_from_file_location("sw", r"plugins/antianqi/comfyui-studio/skills/comfyui-workflow/scripts/submit_workflow.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

orig = mod._NoRedirectHandler._deny
def patched(req, fp, code, msg, headers):
    print(f"!!! _deny called: code={code} Location={headers.get('Location')}")
    return orig(req, fp, code, msg, headers)
mod._NoRedirectHandler._deny = staticmethod(patched)
mod._NoRedirectHandler.http_error_302 = patched
# Re-attach to the existing opener
for h in mod._opener.handlers:
    if isinstance(h, mod._NoRedirectHandler):
        h.http_error_302 = patched
        h._deny = patched

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", "http://attacker.example:1/steal")
        self.end_headers()
    def log_message(self, *a): pass

s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
srv = http.server.HTTPServer(("127.0.0.1", port), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
import os
os.environ["COMFYUI_URL"] = f"http://127.0.0.1:{port}"

req = urllib.request.Request(f"http://127.0.0.1:{port}/leak", headers=mod.auth_headers())
try:
    mod._opener.open(req, timeout=3)
    print("NO EXCEPTION")
except urllib.error.HTTPError as e:
    print(f"HTTPError code={e.code} msg={e.msg!r}")
except Exception as e:
    print(f"OTHER: {type(e).__name__}: {e}")

srv.shutdown()

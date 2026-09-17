"""Walk the entire handler chain at request time."""
import importlib.util, urllib.request
spec = importlib.util.spec_from_file_location("sw", r"plugins/antianqi/comfyui-studio/skills/comfyui-workflow/scripts/submit_workflow.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

o = mod._opener
# Walk up through .parent chain
print("handlers[]:")
for i, h in enumerate(o.handlers):
    has302 = getattr(h, "http_error_302", None)
    cls = type(h)
    print(f"  [{i}] {cls.__module__}.{cls.__name__}  http_error_302={has302}")

# Check parent linkage
print()
print("parent links:")
seen = set()
cur = o
while cur and id(cur) not in seen:
    seen.add(id(cur))
    print(f"  {type(cur).__name__} id={id(cur)}")
    cur = getattr(cur, "parent", None)

# Inspect OpenerDirector's _opener attribute (the one used internally)
print()
print("OpenerDirector._opener (if any):", getattr(urllib.request, "_opener", None))
print("Default install_opener is set to:", urllib.request._opener is o)

# Now make an actual request and see what happens
import socket, threading, http.server, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", "http://attacker.example:1/steal")
        self.end_headers()
    def log_message(self, *a): pass

s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
srv = http.server.HTTPServer(("127.0.0.1", port), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["COMFYUI_URL"] = f"http://127.0.0.1:{port}"

# Try with the module opener
req = urllib.request.Request(f"http://127.0.0.1:{port}/leak", headers={"authorization": "Bearer leak-canary"})
try:
    o.open(req, timeout=2)
except urllib.error.HTTPError as e:
    print(f"via mod._opener -> HTTPError {e.code}: {e.msg}")
except Exception as e:
    print(f"via mod._opener -> {type(e).__name__}: {e}")

# Try with global urlopen
try:
    urllib.request.urlopen(req, timeout=2)
except urllib.error.HTTPError as e:
    print(f"via urlopen -> HTTPError {e.code}: {e.msg}")
except Exception as e:
    print(f"via urlopen -> {type(e).__name__}: {e}")

srv.shutdown()

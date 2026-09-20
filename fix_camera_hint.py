#!/usr/bin/env python3
"""
Adds an on-screen instruction while the camera is running (laptop/single-camera
case), so users know to hold their doc/photo up to the screen and hit Capture.

Run from ~/GeeMack:  python3 fix_camera_hint.py
"""
import shutil
import time

ts = time.strftime("%Y%m%d%H%M%S")

# ---------- CameraOCR.jsx ----------
jsx_path = "web/src/tabs/CameraOCR.jsx"
shutil.copy(jsx_path, f"{jsx_path}.bak.{ts}")

with open(jsx_path, "r") as f:
    jsx = f.read()

old_jsx = (
    '      </div>\n'
    '\n'
    '      <div className="lang-bar cam-lang-bar">\n'
    '        <select className="lang-sel'
)
new_jsx = (
    '      </div>\n'
    '\n'
    '      {cameraOn && singleCameraOnly && (\n'
    '        <div className="cam-hint">\n'
    '          Hold your document or photo up to the screen, then tap "Capture &amp; Translate" below.\n'
    '        </div>\n'
    '      )}\n'
    '\n'
    '      <div className="lang-bar cam-lang-bar">\n'
    '        <select className="lang-sel'
)

assert jsx.count(old_jsx) == 1, f"expected 1 match in {jsx_path}, found {jsx.count(old_jsx)}"

# ---------- CameraOCR.css ----------
css_path = "web/src/tabs/CameraOCR.css"
shutil.copy(css_path, f"{css_path}.bak.{ts}")

with open(css_path, "r") as f:
    css = f.read()

assert ".cam-hint" not in css, ".cam-hint already exists in CameraOCR.css -- aborting, check manually"

css_addition = (
    "\n"
    ".cam-hint {\n"
    "  font-size: 13px;\n"
    "  line-height: 1.4;\n"
    "  color: #fff;\n"
    "  background: rgba(0, 0, 0, 0.55);\n"
    "  border-radius: 8px;\n"
    "  padding: 8px 12px;\n"
    "  margin: 6px 0 4px;\n"
    "  text-align: center;\n"
    "}\n"
)

# Both assertions passed -- now write.
with open(jsx_path, "w") as f:
    f.write(jsx.replace(old_jsx, new_jsx))

with open(css_path, "a") as f:
    f.write(css_addition)

print("OK: inserted cam-hint block into", jsx_path)
print("OK: appended .cam-hint rule to", css_path)
print(f"Backups: {jsx_path}.bak.{ts}  {css_path}.bak.{ts}")

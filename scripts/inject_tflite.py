#!/usr/bin/env python3
"""
Inject pose_landmarker_lite.task into SpeedgunMobile.xcodeproj/project.pbxproj.

Run from repo root:
  python scripts/inject_tflite.py

Must be run after every: cd ios && xcodegen generate
"""
import re, sys
from pathlib import Path

pbxproj = str(Path(__file__).resolve().parents[1] / "ios" / "SpeedgunMobile.xcodeproj" / "project.pbxproj")

with open(pbxproj) as f:
    content = f.read()

MODEL_FILE = "pose_landmarker_lite.task"

# Clean previous inject
if MODEL_FILE in content:
    print(f"{MODEL_FILE} already in pbxproj — removing for clean re-inject")
    content = '\n'.join(l for l in content.split('\n') if MODEL_FILE not in l)
    content = re.sub(
        r'/\* Begin PBXResourcesBuildPhase section \*/.*?/\* End PBXResourcesBuildPhase section \*/\n',
        '', content, flags=re.DOTALL
    )
    content = re.sub(r'\t+CC00DD11EE22FF33AA44BB56 /\* Resources \*/,\n', '', content)

FILE_REF_ID        = "AA00BB11CC22DD33EE44FF56"
BUILD_FILE_ID      = "BB00CC11DD22EE33FF44AA56"
RESOURCES_PHASE_ID = "CC00DD11EE22FF33AA44BB56"

# 1. PBXBuildFile entry
content = content.replace(
    "/* End PBXBuildFile section */",
    f'\t\t{BUILD_FILE_ID} /* {MODEL_FILE} in Resources */ = {{isa = PBXBuildFile; fileRef = {FILE_REF_ID} /* {MODEL_FILE} */; }};\n'
    "/* End PBXBuildFile section */"
)

# 2. PBXFileReference entry
content = content.replace(
    "/* End PBXFileReference section */",
    f'\t\t{FILE_REF_ID} /* {MODEL_FILE} */ = {{isa = PBXFileReference; lastKnownFileType = file; path = "{MODEL_FILE}"; sourceTree = "<group>"; }};\n'
    "/* End PBXFileReference section */"
)

# 3. Add file ref to the sources group (path = .)
# The group ends with:
#   		);
#   		name = .;
#   		path = .;
# We insert the file ref just before that closing );
content = re.sub(
    r'(\t\t\t\);(\n\t\t\tname = \.))',
    f'\t\t\t\t{FILE_REF_ID} /* {MODEL_FILE} */,\n\t\t\t);\n\t\t\tname = .',
    content,
    count=1
)

# 4. PBXResourcesBuildPhase block
resources_phase = (
    "/* Begin PBXResourcesBuildPhase section */\n"
    f"\t\t{RESOURCES_PHASE_ID} /* Resources */ = {{\n"
    "\t\t\tisa = PBXResourcesBuildPhase;\n"
    "\t\t\tbuildActionMask = 2147483647;\n"
    "\t\t\tfiles = (\n"
    f"\t\t\t\t{BUILD_FILE_ID} /* {MODEL_FILE} in Resources */,\n"
    "\t\t\t);\n"
    "\t\t\trunOnlyForDeploymentPostprocessing = 0;\n"
    "\t\t};\n"
    "/* End PBXResourcesBuildPhase section */\n"
)
content = content.replace(
    "/* Begin PBXSourcesBuildPhase section */",
    resources_phase + "/* Begin PBXSourcesBuildPhase section */"
)

# 5. Add Resources phase to target's buildPhases
# Find the Sources phase ID dynamically
sources_match = re.search(r'(\w+) /\* Sources \*/ = \{\n\t\t\tisa = PBXSourcesBuildPhase', content)
if sources_match:
    sources_id = sources_match.group(1)
    content = content.replace(
        f'buildPhases = (\n\t\t\t\t{sources_id} /* Sources */,',
        f'buildPhases = (\n\t\t\t\t{RESOURCES_PHASE_ID} /* Resources */,\n\t\t\t\t{sources_id} /* Sources */,'
    )
else:
    print("WARNING: could not find Sources build phase ID")

with open(pbxproj, 'w') as f:
    f.write(content)

count = content.count(MODEL_FILE)
print(f"Done — {MODEL_FILE} appears {count} times in pbxproj")
if count < 4:
    print("WARNING: fewer than 4 occurrences, injection may be incomplete")
    sys.exit(1)
else:
    print("Success: Resources phase added and model file injected")

"""Create the portable payload without Windows MAX_PATH truncation."""
import os
import sys
import zipfile


def native(path):
    path = os.path.abspath(path)
    if os.name != "nt" or path.startswith("\\\\?\\"):
        return path
    return "\\\\?\\UNC\\" + path[2:] if path.startswith("\\\\") else "\\\\?\\" + path


source, target = map(native, sys.argv[1:3])
with zipfile.ZipFile(target, "x", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
    for directory, folders, files in os.walk(source):
        folders.sort()
        for name in sorted(files):
            file = os.path.join(directory, name)
            archive.write(file, os.path.relpath(file, source).replace("\\", "/"))

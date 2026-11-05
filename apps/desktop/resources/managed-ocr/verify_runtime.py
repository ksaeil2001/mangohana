"""Read-only verification of pinned wheels and every extracted runtime file.

Ported from the managed OCR verifier; no package installation or downloads.
"""
import sys

# The signed embedded interpreter's _pth can enable site. Do this before importing
# anything beyond builtins; neither the wheel target nor base site-packages belongs
# on this verifier's import path. -I alone does not exclude base site-packages.
_base = sys.base_prefix
_version = "{}.{}".format(*sys.version_info[:2])
if sys.platform == "win32":
    sys.path[:] = [_base + "/python" + _version.replace(".", "") + ".zip",
                   _base + "/Lib", _base + "/DLLs", _base]
else:
    sys.path[:] = [_base + "/lib/python" + _version,
                   _base + "/lib/python" + _version + "/lib-dynload"]

import base64
import csv
import hashlib
import io
import os
import re
import stat
import unicodedata
import zipfile
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

if sys.platform == "win32":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class _FileBasicInfo(ctypes.Structure):
        _fields_ = [("creation", ctypes.c_longlong), ("access", ctypes.c_longlong),
                    ("write", ctypes.c_longlong), ("change", ctypes.c_longlong),
                    ("attributes", wintypes.DWORD)]

    if (ctypes.sizeof(_FileBasicInfo), _FileBasicInfo.change.offset, _FileBasicInfo.attributes.offset) != (40, 24, 32):
        raise RuntimeError("Unexpected Windows file information ABI")
    _query_basic_info = ctypes.WinDLL("kernel32", use_last_error=True).GetFileInformationByHandleEx
    _query_basic_info.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _query_basic_info.restype = wintypes.BOOL

MAX_ENTRIES = 32768
MAX_TOTAL = 1024 ** 3
MAX_SINGLE = 512 * 1024 ** 2
MAX_RATIO = 200
CHUNK = 1024 * 1024
_RESERVED = re.compile(r"^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", re.I)
_SHA = re.compile(r"^[0-9a-f]{64}$")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_parts(name):
    require(isinstance(name, str) and name and name == unicodedata.normalize("NFC", name), "invalid path")
    parts = name.split("/")
    for part in parts:
        require(part not in ("", ".", "..") and not part.endswith((".", " "))
                and not _RESERVED.match(part)
                and not any(ord(c) < 32 or c in '\\:<>"|?*' for c in part), "unsafe path")
    return parts


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def handle_identity(handle):
    result = identity(os.fstat(handle.fileno()))
    if sys.platform == "win32":
        # Python 3.10 st_ctime is creation time on Windows. Native ChangeTime
        # detects a same-size overwrite even if a writer restores LastWriteTime.
        info = _FileBasicInfo()
        if not _query_basic_info(msvcrt.get_osfhandle(handle.fileno()), 0,
                                 ctypes.byref(info), ctypes.sizeof(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        result += (info.change,)
    return result


def checked_stat(path, directory=False, check_canonical=True):
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode)
            and not getattr(info, "st_file_attributes", 0) & 0x400, "link/reparse point")
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), "unexpected file type")
    if not directory:
        require(info.st_nlink == 1, "hard linked file")
    if check_canonical:
        require(os.path.normcase(os.path.realpath(path)) == os.path.normcase(str(path)), "canonical path changed")
    return info


def checked_root(value):
    require(isinstance(value, str) and value and "\0" not in value, "invalid root")
    path = Path(value)
    require(path.is_absolute() and str(path) == os.path.abspath(value), "root must be absolute and normalized")
    for part in path.parts[1:]:
        safe_parts(part)
    for parent in reversed((path,) + tuple(path.parents)):
        checked_stat(parent, True)
    return path


def directory_id(path):
    info = checked_stat(path, True)
    return info.st_dev, info.st_ino


def read_hash(stream):
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = stream.read(CHUNK)
        if not chunk:
            break
        size += len(chunk)
        require(size < MAX_SINGLE, "expanded file too large")
        digest.update(chunk)
    return size, digest.hexdigest()


def claim_path(paths, name, directory):
    """Reject case aliases and both file/directory and cross-wheel collisions."""
    parts = safe_parts(name)
    for index in range(1, len(parts) + 1):
        current = "/".join(parts[:index])
        is_dir = directory or index < len(parts)
        key = current.casefold()
        previous = paths.get(key)
        if previous is not None:
            require(previous == (current, True) and is_dir, "duplicate/casefold/file collision")
        else:
            paths[key] = (current, is_dir)


def destination(name, dist):
    parts = safe_parts(name)
    require(not any(part.casefold().endswith(".pth") for part in parts), ".pth is forbidden")
    require(parts[0].casefold() != "_nonimport", "reserved destination")
    if any(part.casefold().endswith(".data") for part in parts):
        if (len(parts) == 6 and parts[0] == dist + ".data"
                and parts[1:5] == ["data", "share", "man", "man1"]
                and re.fullmatch(r"[A-Za-z0-9_-]+\.1", parts[5])):
            # SymPy's wheel ships a man page. Preserve its bytes without
            # installing data into the base prefix or adding an import path.
            return "_nonimport/_wheel_data/" + dist + "/" + "/".join(parts[2:])
        require(len(parts) == 3 and parts[0] == dist + ".data" and parts[1] == "scripts", "unsupported .data scheme")
        return "_nonimport/_wheel_scripts/" + dist + "/" + parts[2]
    return name


def parse_record(archive, record, file_names):
    info = archive.getinfo(record)
    require(info.file_size < 16 * 1024 ** 2, "RECORD too large")
    rows = {}
    text = archive.read(info).decode("utf-8", "strict")
    for row in csv.reader(io.StringIO(text, newline=""), strict=True):
        require(len(row) == 3, "invalid RECORD row")
        name, encoded, size_text = row
        safe_parts(name)
        require(name not in rows, "duplicate RECORD row")
        if name == record and encoded == "" and size_text == "":
            rows[name] = None
            continue
        require(encoded.startswith("sha256=") and re.fullmatch(r"sha256=[A-Za-z0-9_-]{43}", encoded)
                and re.fullmatch(r"0|[1-9][0-9]*", size_text), "missing/unsupported RECORD hash or size")
        digest = base64.urlsafe_b64decode(encoded[7:] + "=")
        require(len(digest) == 32 and base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii") == encoded[7:], "noncanonical RECORD hash")
        rows[name] = (int(size_text), digest.hex())
    require(set(rows) == file_names, "RECORD must cover exactly every wheel file")
    return rows


def plan_wheels(wheel_root, files, stack):
    require(isinstance(files, list) and 0 < len(files) <= 128, "invalid wheel catalog")
    wheel_names = set()
    source_handles = []
    output_paths = {}
    expected = {}
    entries = total = 0
    for file in files:
        require(isinstance(file, dict) and set(file) == {"path", "url", "size", "sha256"}, "invalid catalog entry")
        name = file["path"]
        require(len(safe_parts(name)) == 1 and name.endswith(".whl"), "wheel must be a basename")
        require(name.casefold() not in wheel_names, "duplicate wheel")
        wheel_names.add(name.casefold())
        require(type(file["size"]) is int and 0 < file["size"] < MAX_SINGLE
                and isinstance(file["sha256"], str) and _SHA.fullmatch(file["sha256"]), "wheel is not pinned")
        require(isinstance(file["url"], str) and file["url"].startswith("https://"), "invalid catalog URL")
        path = wheel_root / name
        before = checked_stat(path)
        handle = stack.enter_context(open(path, "rb"))
        require(identity(before) == identity(os.fstat(handle.fileno())), "wheel handle changed")
        fingerprint = handle_identity(handle)
        require(read_hash(handle) == (file["size"], file["sha256"]), "wheel hash/size mismatch")
        require(fingerprint == handle_identity(handle), "wheel changed while hashing")
        handle.seek(0)
        archive = stack.enter_context(zipfile.ZipFile(handle))
        source_handles.append((path, before, handle, fingerprint))
        local_paths = {}
        seen_entries = set()
        file_infos = {}
        dist = "-".join(name[:-4].split("-")[:2])
        require(not dist.casefold().startswith("pip-"), "pip is not part of the runtime")
        record = dist + ".dist-info/RECORD"
        for info in archive.infolist():
            entries += 1
            total += info.file_size
            require(entries < MAX_ENTRIES and total < MAX_TOTAL and info.file_size < MAX_SINGLE, "wheel expansion limit")
            require(not info.flag_bits & 1 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "unsupported ZIP entry")
            require(info.file_size == 0 or (info.compress_size > 0 and info.file_size < info.compress_size * MAX_RATIO), "ZIP compression ratio")
            mode = stat.S_IFMT(info.external_attr >> 16)
            is_dir = info.is_dir()
            require(mode in (0, stat.S_IFDIR if is_dir else stat.S_IFREG)
                    and not info.external_attr & 0x400, "ZIP link/special file")
            require(info.orig_filename == info.filename, "ZIP NUL path")
            entry = info.filename[:-1] if is_dir else info.filename
            # Even duplicate directory entries in one wheel are ambiguous.
            require(entry.casefold() not in seen_entries, "duplicate ZIP entry")
            seen_entries.add(entry.casefold())
            claim_path(local_paths, entry, is_dir)
            safe_parts(entry)
            require(not any(p.casefold().endswith(".pth") for p in entry.split("/")), ".pth is forbidden")
            if is_dir:
                require(info.file_size == 0, "nonempty ZIP directory")
                # Explicit .data parent directories are allowed only for scripts.
                parts = entry.split("/")
                if any(p.casefold().endswith(".data") for p in parts):
                    require(parts in ([dist + ".data"], [dist + ".data", "scripts"]), "unsupported .data directory")
                continue
            file_infos[entry] = info
        require(record in file_infos, "wheel RECORD missing")
        require({p.split("/")[0] for p in file_infos if p.split("/")[0].endswith(".dist-info")} == {dist + ".dist-info"}, "unexpected distribution metadata")
        rows = parse_record(archive, record, set(file_infos))
        for name, info in file_infos.items():
            with archive.open(info) as source:
                actual = read_hash(source)
            require(actual[0] == info.file_size and (rows[name] is None or rows[name] == actual), "RECORD hash/size mismatch")
            target = destination(name, dist)
            claim_path(output_paths, target, False)
            expected[target] = (archive, info, actual)
    require({p.name.casefold() for p in wheel_root.iterdir()} == wheel_names, "unexpected wheelhouse entry")
    return expected, source_handles, output_paths


def check_sources(handles):
    for path, before, handle, fingerprint in handles:
        require(identity(before) == identity(checked_stat(path)) == identity(os.fstat(handle.fileno())), "wheel identity changed")
        require(fingerprint == handle_identity(handle), "wheel content changed")


def verify_target(root, expected, output_paths):
    found = set()
    snapshot = {}
    def verify_file(child, name):
        first = checked_stat(child, check_canonical=False)
        with open(child, "rb") as handle:
            require(identity(first) == identity(os.fstat(handle.fileno())), "target handle changed")
            fingerprint = handle_identity(handle)
            require(read_hash(handle) == expected[name][2], "target hash/size mismatch")
            require(fingerprint == handle_identity(handle), "target changed while hashing")
            require(identity(first) == identity(os.fstat(handle.fileno())) == identity(checked_stat(child, check_canonical=False)), "target identity changed")
        return name, identity(first), fingerprint

    # Enumerate the complete tree, including non-import data. Unknown files and
    # empty directories are errors, not something to silently ignore.
    def visit(directory, prefix=""):
        before = identity(checked_stat(directory, True))
        pending = []
        def drain():
            for future in pending:
                name, original, fingerprint = future.result()
                found.add(name)
                snapshot[root.joinpath(*safe_parts(name))] = (False, original, fingerprint)
            pending.clear()
        for child in directory.iterdir():
            name = prefix + child.name
            safe_parts(name)
            entry = output_paths.get(name.casefold())
            require(entry is not None and entry[0] == name, "unknown target entry")
            if entry[1]:
                drain()
                checked_stat(child, True)
                visit(child, name + "/")
            else:
                # Actual iterdir leaf, bounded by the parent's canonical and
                # identity checks before/after traversal. The regular-file,
                # reparse, hardlink, handle and content checks remain per file.
                pending.append(pool.submit(verify_file, child, name))
                if len(pending) == 4:
                    drain()
        drain()
        require(before == identity(checked_stat(directory, True)), "target directory changed")
        snapshot[directory] = (True, before, None)
    # One pool and at most four submitted jobs across the whole traversal.
    # A failure leaves the context only after every submitted file is closed.
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="ocr-cache-verify") as pool:
        visit(root)
    require(found == set(expected), "missing target file")
    return snapshot


def verify_runtime(wheel_root, runtime_root, runtime_files):
    """Verify wheel hashes, RECORDs, exact extracted tree, and reparse/identity safety."""
    wheel_root = checked_root(str(wheel_root))
    target_root = checked_root(str(runtime_root))
    require(wheel_root != target_root and wheel_root not in target_root.parents
            and target_root not in wheel_root.parents, "overlapping roots")
    base_root = Path(os.path.abspath(sys.base_prefix))
    require(base_root != target_root and base_root not in target_root.parents
            and target_root not in base_root.parents, "base Python is immutable")
    root_ids = (directory_id(wheel_root), directory_id(target_root))
    with ExitStack() as stack:
        expected, handles, paths = plan_wheels(wheel_root, runtime_files, stack)
        check_sources(handles)
        snapshot = verify_target(target_root, expected, paths)
        check_sources(handles)
        for path, before, handle, fingerprint in handles:
            snapshot[path] = (False, identity(before), fingerprint)
        snapshot[wheel_root] = (True, identity(checked_stat(wheel_root, True)), None)
        require({p.name for p in wheel_root.iterdir()} == {file["path"] for file in runtime_files},
                "wheelhouse changed")
        require(root_ids == (directory_id(checked_root(str(wheel_root))),
                             directory_id(checked_root(str(target_root)))), "root identity changed")
    return snapshot


def assert_unchanged(snapshot):
    """Recheck verified file/directory identities before using lazy imports or assets."""
    for path, (directory, original, fingerprint) in snapshot.items():
        current = checked_stat(path, directory, check_canonical=False)
        require(identity(current) == original, "verified asset changed")
        if not directory and sys.platform == "win32":
            with open(path, "rb") as handle:
                require(handle_identity(handle) == fingerprint, "verified asset content changed")

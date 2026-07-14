from __future__ import annotations

import base64
import ctypes
import os
from ctypes import wintypes


_DPAPI_PREFIX = "dpapi:"
_BASE64_PREFIX = "base64:"


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def _protect_windows(value: str) -> str:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_DataBlob),
        wintypes.LPCWSTR,
        ctypes.POINTER(_DataBlob),
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(_DataBlob),
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel32.LocalFree.restype = wintypes.HLOCAL

    raw = value.encode("utf-8")
    source_buffer = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    source = _DataBlob(len(raw), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    encrypted = _DataBlob()
    if not crypt32.CryptProtectData(ctypes.byref(source), "QQ Bot Control Panel", None, None, None, 0, ctypes.byref(encrypted)):
        raise RuntimeError("Windows 无法保护账号密码")
    try:
        protected = ctypes.string_at(encrypted.pbData, encrypted.cbData)
    finally:
        kernel32.LocalFree(encrypted.pbData)
    return _DPAPI_PREFIX + base64.b64encode(protected).decode("ascii")


def _unprotect_windows(value: str) -> str:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_DataBlob),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(_DataBlob),
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(_DataBlob),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel32.LocalFree.restype = wintypes.HLOCAL

    encoded = value.removeprefix(_DPAPI_PREFIX)
    protected = base64.b64decode(encoded.encode("ascii"))
    source_buffer = (ctypes.c_ubyte * len(protected)).from_buffer_copy(protected)
    source = _DataBlob(len(protected), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    decrypted = _DataBlob()
    description = wintypes.LPWSTR()
    if not crypt32.CryptUnprotectData(ctypes.byref(source), ctypes.byref(description), None, None, None, 0, ctypes.byref(decrypted)):
        raise RuntimeError("Windows 无法读取账号密码")
    try:
        raw = ctypes.string_at(decrypted.pbData, decrypted.cbData)
    finally:
        if description:
            kernel32.LocalFree(description)
        kernel32.LocalFree(decrypted.pbData)
    return raw.decode("utf-8")


def protect_secret(value: str | None) -> str:
    """Protect a secret for this Windows user; blank values stay blank."""
    if not value:
        return ""
    if os.name == "nt":
        return _protect_windows(value)
    return _BASE64_PREFIX + base64.b64encode(value.encode("utf-8")).decode("ascii")


def reveal_secret(value: str | None) -> str:
    if not value:
        return ""
    if value.startswith(_DPAPI_PREFIX):
        if os.name != "nt":
            raise RuntimeError("此账号密码由 Windows 账户保护，只能在原 Windows 用户下使用")
        return _unprotect_windows(value)
    if value.startswith(_BASE64_PREFIX):
        return base64.b64decode(value.removeprefix(_BASE64_PREFIX)).decode("utf-8")
    return ""

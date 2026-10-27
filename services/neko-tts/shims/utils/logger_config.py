"""Minimal stand-in for upstream utils.logger_config (not vendored)."""

import logging


def get_module_logger(name: str, service: str = "Main") -> logging.Logger:
    return logging.getLogger(f"neko-tts.{name}")

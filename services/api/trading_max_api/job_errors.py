"""Stable control-plane errors shared by all job-manager implementations."""

from __future__ import annotations


class JobConflict(RuntimeError):
    """The requested job transition conflicts with an active job."""


__all__ = ["JobConflict"]

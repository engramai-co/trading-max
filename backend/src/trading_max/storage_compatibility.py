"""Exercise retained readers before an operator enables a physical format."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from .service_retention import ServiceRetention

_READER_PROBE = r"""
import json, sqlite3, tempfile
from pathlib import Path
from trading_max import __version__
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore, compressed_json
from trading_max.infrastructure.history_chunks import canonical
from trading_max.backup_repository import BackupRepository
from trading_max.research.disclosures import ResearchEvidenceProvider
with tempfile.TemporaryDirectory(prefix="trading-max-reader-probe-") as scratch:
    root = Path(scratch)
    state = root / "state"
    state.mkdir()
    with sqlite3.connect(state / "trading_max.db") as db:
        db.execute("CREATE TABLE synthetic(value INTEGER)")
    writer = ContentAddressedArtifactStore(state / "artifacts", history_mode="chunked", storage_mode="chunked")
    one = writer.put_json(key="research/synthetic.json", payload={"rows": [{"n":i,"text":"synthetic"*30} for i in range(500)]})
    two = writer.put_json(key="account/nav/valuation_history.json", payload={"points":[{"bucket_at":"2026-01-01T00:00:00Z","value":12.5}]})
    SnapshotStore(state, artifacts=writer).publish(scope="accounts",source="compatibility-probe",artifacts=[one,two])
    assert SnapshotStore(state).latest().manifest.artifacts[0].artifact_id == one.ref.artifact_id
    raw = writer.content_bytes(one.ref.artifact_id)
    repo = BackupRepository(root / "backup")
    backup = repo.create(state)
    repo.restore(backup["id"],root/"restore")
    assert ContentAddressedArtifactStore(root/"restore/artifacts").content_bytes(one.ref.artifact_id) == raw
    import hashlib
    digest=hashlib.sha256(raw).hexdigest()
    packed=ContentAddressedArtifactStore(repo.root/"packed")
    repo.packed_path(digest).write_bytes(canonical(packed.json_chunks.encode(raw)))
    with repo.open_blob(digest) as handle:
        assert handle.read() == raw
    path=root/"cache.html"
    path.write_bytes(compressed_json.encode(b"synthetic filing"*1000))
    assert ResearchEvidenceProvider._read_cache(path) == "synthetic filing"*1000
print(json.dumps({"version":__version__,"verified":True}))
"""


_PACK_PROBE = r"""
import gzip, hashlib, json, shutil, sqlite3, tempfile
from pathlib import Path
from trading_max import __version__
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.infrastructure.object_packs import ObjectPacks
from trading_max.backup_repository import BackupRepository, atomic_json
with tempfile.TemporaryDirectory(prefix="trading-max-pack-probe-") as scratch:
    root=Path(scratch);state=root/"state";state.mkdir()
    with sqlite3.connect(state/"trading_max.db") as db:db.execute("CREATE TABLE synthetic(v INTEGER)")
    store=ContentAddressedArtifactStore(state/"artifacts",history_mode="chunked",storage_mode="chunked")
    items=[store.put_json(key="account/nav/valuation_history.json",payload={"points":[{"bucket_at":"2026-01-01T00:00:00Z","value":12.50001,"source_artifact_ids":None}]}),store.put_json(key="research/synthetic.json",payload={"rows":[{"v":n,"s":"synthetic"*100} for n in range(1000)]})]
    original={i.ref.artifact_id:store.content_bytes(i.ref.artifact_id) for i in items}
    SnapshotStore(state,artifacts=store).publish(scope="accounts",source="pack-probe",artifacts=items)
    records={};paths=[]
    for family,prefix in [("json-chunks","json"),("history-chunks","history")]:
        for p in (store.root/family).rglob("*.gz"):records[prefix+"/"+p.stem]=gzip.decompress(p.read_bytes());paths.append(p)
    for p in store.content_root.iterdir():records["artifact/"+p.name]=p.read_bytes();paths.append(p)
    store.packs.add(records)
    for p in paths:p.unlink()
    for aid,raw in original.items():assert store.content_bytes(aid)==raw
    repo=BackupRepository(root/"backup");backup=repo.create(state,artifact_encoding="logical")
    raw=repo.manifest_bytes(backup["id"]);atomic_json(repo.manifest_path(backup["id"]),repo.manifest_catalog.encode(raw,backup["id"]))
    repo.packs.close();repo.packs.index.unlink();repo.packs.rebuild()
    assert repo.manifest_bytes(backup["id"])==raw
    store.packs.close();shutil.rmtree(state)
    repo.restore(backup["id"],root/"restore")
    restored=ContentAddressedArtifactStore(root/"restore/artifacts")
    for aid,raw in original.items():assert restored.content_bytes(aid)==raw
print(json.dumps({"version":__version__,"verified":True,"format":"object-packs-v1"}))
"""


def verify_retained_readers(service: Path, *, object_packs: bool = False) -> dict:
    retention = ServiceRetention(service)
    context = retention._context()
    protected = context["protected"]
    if len(protected) < 3:
        raise ValueError("format activation requires current and two retained rollback runtimes")
    reports = []
    environment = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
    for name in protected:
        root = Path(name)
        result = subprocess.run(  # noqa: S603 - validated retained runtime, fixed synthetic probe
            [str(root / ".venv/bin/python"), "-c", _PACK_PROBE if object_packs else _READER_PROBE],
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=90,
        )
        if result.returncode:
            raise ValueError(f"retained runtime cannot recover compact storage: {root.name}")
        report = json.loads(result.stdout)
        if report.get("verified") is not True:
            raise ValueError("retained reader probe did not confirm recovery")
        reports.append({"runtime": root.name, **report})
    return {"deploymentFingerprint": context["fingerprint"], "readers": reports}

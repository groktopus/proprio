"""Bounded independent oracle for the structured-goal recovery deliverable."""
import argparse
import hashlib
import json
import pathlib
import selectors
import stat
import subprocess
import tempfile
import time
import zipfile

IMAGE = "python@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285"
EXPECTED_FILES = {"goal-checkpoint.json", "milestones.jsonl", "verify_goal.py", "goal-output.txt"}


def inspect(archive: pathlib.Path, nonce: str) -> dict:
    checks = []
    def check(name: str, passed: bool):
        checks.append({"id": name, "passed": bool(passed), "detail": "independent deliverable oracle"})

    if archive.stat().st_size > 1_000_000:
        return {"passed": False, "checks": [{"id": "archive-size-bounded", "passed": False,
                "detail": "independent deliverable oracle"}], "output": None, "checkpointSha256": None}

    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        names = [entry.filename for entry in entries]
        safe = len(entries) == 4 and set(names) == EXPECTED_FILES and len(set(names)) == len(names)
        for entry in entries:
            path = pathlib.PurePosixPath(entry.filename)
            safe = safe and not path.is_absolute() and ".." not in path.parts and "\\" not in entry.filename
            safe = safe and not stat.S_ISLNK(entry.external_attr >> 16)
            safe = safe and entry.file_size <= 256_000
        check("archive-members-safe", safe)
        if not safe:
            return {"passed": False, "checks": checks, "output": None, "checkpointSha256": None}
        with tempfile.TemporaryDirectory(prefix="proprio-goal-oracle-") as tmp:
            root = pathlib.Path(tmp)
            for entry in entries:
                target = root / entry.filename
                with source.open(entry) as member:
                    data = member.read(256_001)
                    if len(data) > 256_000 or len(data) != entry.file_size:
                        raise ValueError("archive member exceeded its declared bound")
                target.write_bytes(data)
            checkpoint_bytes = (root / "goal-checkpoint.json").read_bytes()
            try:
                checkpoint = json.loads(checkpoint_bytes)
            except Exception:
                checkpoint = None
            check("checkpoint-exact", checkpoint == {"nonce": nonce, "milestone": "checkpoint"})
            milestone_lines = (root / "milestones.jsonl").read_text(encoding="utf-8").splitlines()
            check("milestones-exactly-once", milestone_lines == [f"checkpoint:{nonce}", f"verified:{nonce}"])
            expected_output = f"GOAL_OUTPUT:{nonce}\n"
            check("saved-output-exact", (root / "goal-output.txt").read_text(encoding="utf-8") == expected_output)
            root.chmod(0o755)
            script = root / "verify_goal.py"
            script.chmod(0o444)
            command = ["docker", "run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
                       "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=96m", "--memory-swap=96m",
                       "--cpus=1", "--user=65534:65534", "--log-driver=none", "--mount",
                       f"type=bind,source={root},target=/project,readonly", "--workdir", "/project", IMAGE,
                       "python", "-I", "-B", "verify_goal.py", nonce]
            output = ""
            executable_ok = False
            try:
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                assert process.stdout is not None
                selector = selectors.DefaultSelector()
                selector.register(process.stdout, selectors.EVENT_READ)
                chunks = []
                size = 0
                deadline = time.monotonic() + 20
                oversized = False
                while selector.get_map() and time.monotonic() < deadline:
                    for key, _ in selector.select(max(0, deadline - time.monotonic())):
                        chunk = key.fileobj.read(1024)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        size += len(chunk)
                        if size > 4096:
                            oversized = True
                            process.kill()
                            break
                        chunks.append(chunk)
                    if oversized:
                        break
                if process.poll() is None:
                    process.kill()
                returncode = process.wait(timeout=2)
                output = b"".join(chunks).decode("utf-8", errors="strict") if not oversized else ""
                executable_ok = not oversized and returncode == 0 and output == expected_output
            except Exception:
                output = ""
                executable_ok = False
            check("executable-output", executable_ok)
            digest = hashlib.sha256(checkpoint_bytes).hexdigest()
            return {"passed": all(item["passed"] for item in checks), "checks": checks,
                    "output": output.rstrip("\n") if executable_ok else None, "checkpointSha256": digest}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=pathlib.Path)
    parser.add_argument("nonce")
    args = parser.parse_args()
    try:
        result = inspect(args.archive, args.nonce)
    except Exception:
        result = {"passed": False, "checks": [{"id": "archive-readable", "passed": False, "detail": "independent deliverable oracle"}],
                  "output": None, "checkpointSha256": None}
    print(json.dumps(result, separators=(",", ":")))
    raise SystemExit(0 if result["passed"] else 1)

"""Download the pinned official DeepSeek tokenizer as data; do not execute archive code."""

import argparse
import hashlib
import io
import json
import pathlib
import urllib.request
import zipfile

URL = "https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip"
SHA256 = "e7310d1dafe0a86d8a5629fe78a7c763760f651db9b8682718a1781dcd6fe495"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=".sessionlore/models/deepseek-v4-tokenizer")
    args = parser.parse_args()
    data = urllib.request.urlopen(URL, timeout=60).read()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise SystemExit("The official tokenizer archive changed. Review the new version before updating the pinned checksum.")
    root = pathlib.Path(args.out)
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for name in ("tokenizer.json", "tokenizer_config.json"):
            content = archive.read(f"deepseek_v4_tokenizer/{name}")
            json.loads(content)
            (root / name).write_bytes(content)
    (root / "origin.json").write_text(json.dumps({"url": URL, "sha256": SHA256}, indent=2) + "\n")
    print(f"Official DeepSeek tokenizer ready: {root.resolve()}")


if __name__ == "__main__":
    main()

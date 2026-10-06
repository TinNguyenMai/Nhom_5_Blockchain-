"""Read-only Phase 3 receipts. Node/Ethers submits transactions; HTTP never signs.

Old reports remain saved when Hardhat restarts, but are not called current-chain
transactions unless the deployment receipt matches the active local node.
"""
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit
from urllib.request import Request, ProxyHandler, build_opener

from fastapi import APIRouter, HTTPException, Query

from .settings import ROOT

router = APIRouter(prefix="/api/blockchain", tags=["Blockchain (read only)"])


def state_dir():
    return Path(os.environ.get("SOLAR_PHASE3_DIR", ROOT / "data" / "phase3"))


def read_manifest():
    file = state_dir() / "deployment.json"
    if not file.exists():
        return None
    result = json.loads(file.read_text(encoding="utf-8"))
    if not re.fullmatch(r"0x[0-9a-fA-F]{64}", result.get("deployment_id", "")):
        raise ValueError("Invalid deployment ID")
    if result.get("chain_id") != 31337:
        raise ValueError("Only local chain 31337 is supported")
    return result


def rpc(manifest, method, params):
    url = urlsplit(manifest["rpc"])
    if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1")
            or url.username or url.password or url.query or url.fragment or url.path not in ("", "/")):
        raise ValueError("RPC must be loopback HTTP")
    request = Request(manifest["rpc"], data=json.dumps({"jsonrpc": "2.0", "id": 1,
        "method": method, "params": params}).encode(), headers={"Content-Type": "application/json"})
    with build_opener(ProxyHandler({})).open(request, timeout=2) as response:
        result = json.load(response)
    if "error" in result:
        raise ValueError(result["error"].get("message", "RPC error"))
    return result["result"]


def active_chain(manifest):
    if rpc(manifest, "eth_chainId", []) != "0x7a69":
        raise ValueError("Wrong chain ID")
    receipt = rpc(manifest, "eth_getTransactionReceipt", [manifest["deployment_tx"]])
    if not receipt or receipt["status"] != "0x1" or receipt["blockHash"] != manifest["deployment_block_hash"]:
        raise ValueError("Hardhat deployment changed; run npm run deploy")
    if rpc(manifest, "eth_getCode", [manifest["market"], "latest"]) == "0x":
        raise ValueError("Market contract is absent")


def annotate_proposals(result):
    """Keep advisory status; attach separately verified local-chain settlements."""
    try:
        manifest = read_manifest()
        if manifest is None:
            return result
        wanted = {item["id"]: item for item in result["items"]}
        matches = []
        for file in (state_dir() / "reports" / manifest["deployment_id"]).glob("*.json"):
            report = json.loads(file.read_text(encoding="utf-8"))
            if report.get("proposal_id") in wanted and report.get("settlement"):
                matches.append(report)
        if not matches:
            return result
        try:
            active_chain(manifest)
            available = True
        except Exception:
            available = False
        for report in matches:
            row = wanted[report["proposal_id"]]
            settlement = report["settlement"]
            verified = False
            if available:
                try:
                    receipt = rpc(manifest, "eth_getTransactionReceipt", [settlement["transaction_hash"]])
                    verified = bool(receipt and receipt["status"] == "0x1" and
                                    receipt["blockHash"] == settlement["block_hash"] and
                                    receipt.get("to", "").lower() == manifest["market"].lower())
                except Exception:
                    available = False
            row["on_chain"] = verified if available else None
            row["chain_execution"] = {"round_id": report["round_id"], "mode": report["mode"],
                "transaction_hash": settlement["transaction_hash"], "current_chain_verified": verified,
                "trade_count": len(report.get("trades", [])), "purpose": "local_demo_only"}
            # A cancelled/unmatched/settled source is still consumed by the contract.
            if verified:
                row["eligible_for_review"] = False
        return result
    except (OSError, ValueError, KeyError):
        # A chain reporting problem must not break MQTT ingestion or advisory history.
        for row in result["items"]:
            row["on_chain"] = None
        return result


@router.get("/status")
def blockchain_status():
    try:
        manifest = read_manifest()
        if manifest is None:
            return {"configured": False, "connected": False, "message": "Run npm run deploy"}
        active_chain(manifest)
        return {"configured": True, "connected": True, "deployment": manifest,
                "purpose": "local_demo_only", "energy_delivery_verified": False}
    except Exception as error:
        return {"configured": (state_dir() / "deployment.json").exists(),
                "connected": False, "error": str(error)}


@router.get("/rounds")
def blockchain_rounds(limit: int = Query(default=50, ge=1, le=500)):
    try:
        manifest = read_manifest()
        if manifest is None:
            return {"items": [], "total": 0, "current_chain_verified": False}
        directory = state_dir() / "reports" / manifest["deployment_id"]
        files = sorted((p for p in directory.glob("*.json") if p.stem.isdigit()),
                       key=lambda p: int(p.stem), reverse=True)
        items = [json.loads(p.read_text(encoding="utf-8")) for p in files[:limit]]
        return {"items": items, "total": len(files), "current_chain_verified": False,
                "note": "Saved confirmations. Use /rounds/{id} or npm run market:report to re-verify."}
    except (ValueError, OSError) as error:
        raise HTTPException(503, str(error)) from error


@router.get("/rounds/{round_id}")
def blockchain_round(round_id: int):
    if round_id < 1:
        raise HTTPException(404, "Round not found")
    try:
        manifest = read_manifest()
        if manifest is None:
            raise HTTPException(404, "No deployment")
        file = state_dir() / "reports" / manifest["deployment_id"] / f"{round_id}.json"
        if not file.exists():
            raise HTTPException(404, "No saved report; run npm run market:report")
        saved = json.loads(file.read_text(encoding="utf-8"))
        active_chain(manifest)
        confirmed = saved.get("settlement")
        if not confirmed:
            return {"report": saved, "current_chain_verified": False, "message": "No settlement yet"}
        receipt = rpc(manifest, "eth_getTransactionReceipt", [confirmed["transaction_hash"]])
        verified = bool(receipt and receipt["status"] == "0x1" and
                        receipt["blockHash"] == confirmed["block_hash"] and
                        receipt.get("to", "").lower() == manifest["market"].lower())
        return {"report": saved, "current_chain_verified": verified,
                "verification_scope": "settlement_receipt; source hashes are verified by market:report"}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(503, str(error)) from error

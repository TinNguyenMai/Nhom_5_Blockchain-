from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import __version__
from .service import Service
from .settings import Settings
from .chain import router as blockchain_router, annotate_proposals

RunFilter = Annotated[str | None, Query(pattern=r"^[0-9a-f]{32}$")]
HouseFilter = Annotated[str | None, Query(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")]
PageSize = Annotated[int, Query(ge=1, le=500)]
Offset = Annotated[int, Query(ge=0)]


class DemoActuatorRequest(BaseModel):
    deployment_id: str = Field(pattern=r"^0x[0-9a-f]{64}$")
    transaction_hash: str = Field(pattern=r"^0x[0-9a-f]{64}$")
    round_id: int = Field(ge=1)
    action: Literal["sell", "buy"]
    source_hash_verified: bool
    settlement_status: Literal[1]
    duration_seconds: int = Field(default=15, ge=1, le=60)


def create_app(settings=None):
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app):
        service = Service(settings)
        app.state.service = service
        service.start()
        try:
            yield
        finally:
            service.stop()

    app = FastAPI(title="P2P Solar — Phase 2 + 3", version=__version__, lifespan=lifespan,
                  description="MQTT → SQLite → đề xuất; actuator demo chỉ nhận settlement đã xác minh.")
    app.include_router(blockchain_router)

    def service():
        return app.state.service

    @app.get("/", include_in_schema=False)
    def dashboard():
        return FileResponse(Path(__file__).parent / "static" / "index.html")

    @app.get("/health", tags=["Status"])
    def health():
        s = service()
        return {"status": "ok", "version": __version__, "mqtt": s.status(),
                "counts": s.store.counts(), "database": str(s.store.path)}

    @app.get("/ready", tags=["Status"])
    def ready():
        ok = service().ready()
        return JSONResponse({"ready": ok, "mqtt": service().status()}, status_code=200 if ok else 503)

    @app.get("/api/runs", tags=["History"])
    def runs(limit: PageSize = 50):
        return {"items": service().store.runs(limit)}

    @app.get("/api/homes", tags=["History"])
    def homes(run_id: RunFilter = None):
        s = service()
        return s.store.homes(s.homes, run_id)

    @app.get("/api/telemetry", tags=["History"])
    def telemetry(run_id: RunFilter = None, household_id: HouseFilter = None,
                  limit: PageSize = 100, offset: Offset = 0, order: Literal['timestamp', 'received'] = 'timestamp'):
        return service().store.records("telemetry", run_id, household_id, limit, offset, order_by_received=order == 'received')

    @app.get("/api/predictions", tags=["History"])
    def predictions(run_id: RunFilter = None, household_id: HouseFilter = None,
                    limit: PageSize = 100, offset: Offset = 0, order: Literal['timestamp', 'received'] = 'timestamp'):
        return service().store.records("predictions", run_id, household_id, limit, offset, order_by_received=order == 'received')

    @app.get("/api/proposals", tags=["Advisory"])
    def proposals(run_id: RunFilter = None, household_id: HouseFilter = None,
                  limit: PageSize = 100, offset: Offset = 0):
        s = service()
        return annotate_proposals(s.store.proposals(s.ready(), run_id, household_id, limit, offset))

    @app.get("/api/overview", tags=["Status"])
    def overview(run_id: RunFilter = None):
        s = service()
        runs = s.store.runs()
        selected = run_id or (runs[0]["run_id"] if runs else None)
        return {"mqtt": s.status(), "counts": s.store.counts(), "runs": runs,
                "policy": {"sell_reserve": settings.sell_reserve, "minimum_kwh": settings.minimum_kwh},
                "selected_run_id": selected, "homes": s.store.homes(s.homes, selected)["items"],
                "predictions": s.store.records("predictions", selected, limit=1),
                "proposals": annotate_proposals(s.store.proposals(s.ready(), selected, limit=15))}

    @app.post("/api/demo/actuator", tags=["Demo"])
    def demo_actuator(command: DemoActuatorRequest):
        if not command.source_hash_verified:
            raise HTTPException(422, "Source hash must be verified before actuator control")
        try:
            result = service().publish_demo_actuator(command.action, command.round_id,
                                                     command.duration_seconds)
        except (RuntimeError, ValueError) as error:
            raise HTTPException(503, str(error)) from error
        return {"published": True, "deployment_id": command.deployment_id,
                "transaction_hash": command.transaction_hash, **result}

    return app

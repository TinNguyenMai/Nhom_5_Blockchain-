from dataclasses import dataclass
from pathlib import Path
import math

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    db_path: Path = ROOT / "data" / "phase2.sqlite3"
    homes_config: Path = ROOT / "config" / "edge_demo.json"
    mqtt_host: str = "127.0.0.1"
    mqtt_port: int = 1884
    mqtt_enabled: bool = True
    device_id: str | None = None
    sell_reserve: float = 0.20
    minimum_kwh: float = 0.01
    stale_seconds: int = 60

    def __post_init__(self):
        if not 1 <= self.mqtt_port <= 65535:
            raise ValueError("MQTT port must be 1..65535")
        if not math.isfinite(self.sell_reserve) or not 0 <= self.sell_reserve < 1:
            raise ValueError("sell_reserve must be >=0 and <1")
        if not math.isfinite(self.minimum_kwh) or self.minimum_kwh <= 0:
            raise ValueError("minimum_kwh must be finite and >0")
        if self.stale_seconds < 1:
            raise ValueError("stale_seconds must be >=1")

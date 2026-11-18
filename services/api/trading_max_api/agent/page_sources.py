"""Read only the local observations already available to page inspection surfaces."""

from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache

from trading_max.infrastructure.acwi_weights import METHOD, AcwiWeights
from trading_max.infrastructure.world_sector_weights import WorldSectorWeights

from ..global_sector_models import GlobalSectorBoard
from ..index_models import GlobalMarketContribution
from ..models import JobRecord
from ..sector_models import SectorBoard, SectorMarketCode


@dataclass(frozen=True)
class PageSources:
    weights: Callable[[str], AcwiWeights | WorldSectorWeights | None]
    board: Callable[[SectorMarketCode], SectorBoard | None]
    world: Callable[[], GlobalSectorBoard | None]
    regions: Callable[[], GlobalMarketContribution | None]
    job: Callable[[str], JobRecord]


def published_page_sources(indices, jobs) -> PageSources:
    # The lifetime of each memo is one request, including the cache-version check.
    @lru_cache(maxsize=2)
    def weights(dimension: str):
        try:
            if dimension == "country":
                value = AcwiWeights.model_validate_json(indices.acwi_weights.path.read_bytes())
                return value if value.method == METHOD else None
            return WorldSectorWeights.model_validate_json(
                indices.world_sector_weights.path.read_bytes()
            )
        except (OSError, ValueError):
            return None

    @lru_cache(maxsize=1)
    def published_job(job_id: str):
        # Match the workspace's public refresh history. Internal queue jobs never enter model context.
        for item in jobs.list(limit=200):
            if item.job_id == job_id:
                return item
        raise FileNotFoundError("Update outside the displayed job history")

    return PageSources(
        weights,
        indices.boards.load,
        indices.observed_world_sectors,
        indices.observed_contribution,
        published_job,
    )

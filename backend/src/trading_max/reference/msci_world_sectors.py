"""MSCI World USD price indices, grouped by current GICS codes."""

from dataclasses import dataclass
from typing import Literal

from .taxonomy import standard_gics_names


@dataclass(frozen=True, slots=True)
class WorldIndustryIndex:
    gics: str
    code: int | None

    @property
    def name(self) -> str:
        return standard_gics_names()[self.gics]

    @property
    def level(self) -> Literal["sector", "group"]:
        return "sector" if len(self.gics) == 2 else "group"

    @property
    def symbol(self) -> str | None:
        return f"^{self.code}-USD-STRD" if self.code else None


WORLD_INDUSTRY_INDICES = (
    WorldIndustryIndex("10", 106796),
    WorldIndustryIndex("15", 106797),
    WorldIndustryIndex("20", 106798),
    WorldIndustryIndex("25", 106799),
    WorldIndustryIndex("30", 106800),
    WorldIndustryIndex("35", 106801),
    WorldIndustryIndex("40", 106802),
    WorldIndustryIndex("45", 106803),
    WorldIndustryIndex("50", 106804),
    WorldIndustryIndex("55", 106805),
    # MSCI discontinued the old industry-group-derived series (106824) in 2023.
    WorldIndustryIndex("60", 132085),
    WorldIndustryIndex("1010", 106806),
    WorldIndustryIndex("1510", 106807),
    WorldIndustryIndex("2010", 106809),
    WorldIndustryIndex("2020", 106811),
    WorldIndustryIndex("2030", 106810),
    WorldIndustryIndex("2510", 106812),
    WorldIndustryIndex("2520", 106902),
    WorldIndustryIndex("2530", 106814),
    WorldIndustryIndex("2550", 106815),
    WorldIndustryIndex("3010", 106838),
    WorldIndustryIndex("3020", 106817),
    WorldIndustryIndex("3030", 106813),
    WorldIndustryIndex("3510", 106820),
    WorldIndustryIndex("3520", 106819),
    WorldIndustryIndex("4010", 106821),
    WorldIndustryIndex("4020", 106823),
    WorldIndustryIndex("4030", 106822),
    WorldIndustryIndex("4510", 106826),
    WorldIndustryIndex("4520", 106825),
    WorldIndustryIndex("4530", 778418),
    WorldIndustryIndex("5010", 106827),
    WorldIndustryIndex("5020", 106816),
    WorldIndustryIndex("5510", 106828),
    # No verified Yahoo USD price series for either current Real Estate group.
    WorldIndustryIndex("6010", None),
    WorldIndustryIndex("6020", None),
)

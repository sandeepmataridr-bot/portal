"""Device-to-encounter associations and therapy episodes.

Observations are bound to an association, never to a bare bed. Therapy rules
only see data from confirmed associations (plan epic 1.7).
"""
from __future__ import annotations

from shared.vigil_contracts import DeviceAssociation, TherapyEpisode


class AssociationRegistry:
    def __init__(self):
        self._assocs: dict[str, DeviceAssociation] = {}
        self._episodes: dict[str, TherapyEpisode] = {}

    def add_episode(self, episode: TherapyEpisode) -> None:
        self._episodes[episode.episode_id] = episode

    def add(self, assoc: DeviceAssociation) -> None:
        for other in self._assocs.values():
            if other.device_id == assoc.device_id and other.end is None and other.association_id != assoc.association_id:
                raise ValueError(f"device {assoc.device_id} already has open association {other.association_id}")
        self._assocs[assoc.association_id] = assoc

    def all(self) -> list[DeviceAssociation]:
        return list(self._assocs.values())

    def episode(self, episode_id: str) -> TherapyEpisode | None:
        return self._episodes.get(episode_id)

    def get(self, association_id: str) -> DeviceAssociation | None:
        return self._assocs.get(association_id)

    def confirm(self, association_id: str, by: str) -> DeviceAssociation:
        if not by:
            raise ValueError("confirmation needs the confirming user")
        a = self._assocs[association_id]
        a.confirmed, a.confirmed_by = True, by
        return a

    def end(self, association_id: str, at: float) -> None:
        self._assocs[association_id].end = at

    def active_for_device(self, device_id: str, t: float) -> DeviceAssociation | None:
        for a in self._assocs.values():
            if a.device_id == device_id and a.start <= t and (a.end is None or t < a.end):
                return a
        return None

    def therapies_for(self, encounter_id: str) -> set[str]:
        return {e.therapy for e in self._episodes.values() if e.encounter_id == encounter_id and e.end is None}

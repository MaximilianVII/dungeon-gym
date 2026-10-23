# SRD 5.1 attribution (CC-BY-4.0)

This work includes material taken from the System Reference Document 5.1
("SRD 5.1") by Wizards of the Coast LLC and available at
https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is
licensed under the Creative Commons Attribution 4.0 International License
available at https://creativecommons.org/licenses/by/4.0/legalcode.

## What is derived from the SRD 5.1

- Class progression tables: hit dice, proficiency bonus, spell slots, Extra
  Attack, multiclassing prerequisites and the multiclass spell-slot rule
  (`src/character/progression.ts`, `src/combat/multiclass.ts`).
- The twelve SRD subclasses and their feature names
  (`src/combat/subclasses.ts`), class features such as Rage, Second Wind,
  Action Surge, Cunning Action, Patient Defense, Bardic Inspiration, Martial
  Arts, Unarmored Defense, Divine Smite and Lay on Hands.
- Spell names and base damage dice (`src/combat/spells.ts`).
- Weapon and armor statistics (`src/character/build.ts`).
- Monster stat blocks for the ordinary creatures (`src/combat/monsters.ts`).
- Core resolution rules: attack rolls, critical hits, advantage and
  disadvantage, conditions, death saving throws.

## Changes made

The material has been **adapted and simplified** for a grid-based roguelite:
feature and spell texts are paraphrased; many effects are simplified (e.g. area
spells use a Dexterity-style save against the caster's attack bonus, some
features refresh per fight rather than per rest, Bardic Inspiration is
self-targeted); monster stat blocks are reduced to the fields the game uses
and scale with dungeon depth.

The Cult Adept, the bosses (Orc Warlord, Spider Broodmother, Bone Lich),
artifacts, gear, elite affixes, the XP curve and the dungeon generator are
original Dungeon Gym content (MIT, see LICENSE).

Dungeon Gym is not affiliated with, endorsed, sponsored or approved by
Wizards of the Coast LLC.

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
- Spell names, base damage dice and "At Higher Levels" scaling
  (`src/combat/spells.ts`); the control spells Sleep, Hold Person, Hypnotic
  Pattern, Conjure Animals and Hunter's Mark (`src/combat/control.ts`);
  Eldritch Invocations (Agonizing Blast, Armor of Shadows, Repelling Blast).
- Weapon and armor statistics (`src/character/build.ts`).
- Monster stat blocks for the ordinary creatures (`src/combat/monsters.ts`).
- Core resolution rules: attack rolls, critical hits, advantage and
  disadvantage, conditions (incl. paralyzed, unconscious, incapacitated),
  concentration, temporary hit points, death saving throws.

## Changes made

The material has been **adapted and simplified** for a grid-based roguelite:
feature and spell texts are paraphrased; many effects are simplified (e.g. area
spells use a Dexterity-style save against the caster's attack bonus, rests
happen only between dungeon levels, a Bardic Inspiration die is only spent on
an attack roll that would miss, conjured beasts act right after their
summoner and leave when the fight ends, a 30-ft cube is a burst of radius 3,
a multi-target ray spell keeps to one target); monster stat blocks are reduced
to the fields the game uses and scale with dungeon depth.

The Cult Adept, the bosses (Orc Warlord, Spider Broodmother, Bone Lich),
artifacts, gear, elite affixes, the XP curve and the dungeon generator are
original Dungeon Gym content (MIT, see LICENSE).

Dungeon Gym is not affiliated with, endorsed, sponsored or approved by
Wizards of the Coast LLC.

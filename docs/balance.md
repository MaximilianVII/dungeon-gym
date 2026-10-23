# Balance

All numbers: the official benchmark (32 fixed seeds × 10 floors, outcome-only
reward), baseline genome of each class, solo. Reproduce with
`node dist/cli.mjs report` (telemetry) and `node dist/cli.mjs bench`.

## 0.4.0 → 0.5.0: parties

Solo results are unchanged (the solo benchmark is identical run for run);
everything below only acts when a bot has party-mates.

Party benchmark (`node dist/cli.mjs bench-party`): 32 fixed seeds × **15**
levels (a party clears 10 levels almost every run, so 10 would not separate
line-ups), outcome-only reward, team score = mean member fitness.

| line-up | baseline | wins | trained (20 gen) | wins |
|---|---|---|---|---|
| fighter, cleric, wizard, rogue | 185.8 | 13 | 211.0 | 20 |

Trained with `node dist/cli.mjs train-party --generations 20 --seed 1`
(population 8, 8 seeds per generation, hold-out selection on 32 seeds).

Role genes, measured on the party benchmark (baseline genes otherwise):

| line-up and change | score | wins |
|---|---|---|
| fighter, cleric, wizard, rogue — baseline | 185.8 | 13 |
| … cleric `healAllies` 0 (no ally heals) | 159.3 | 6 |
| … every member `protectAllies` 0 (no guarding) | 179.9 | 12 |
| fighter, bard, wizard, rogue — baseline (bard inspires) | 163.2 | 8 |
| … bard `inspireBeforeAttack` off | 150.2 | 4 |

- `healAllies`: Healing Word (a bonus action) picks a downed party-mate back
  up, else mends one below the gene's threshold; Cure Wounds as the action,
  stepping up to a downed ally if needed.
- `protectAllies`: with that probability per turn, the bot goes for a foe
  next to a party-mate below half HP that it can reach or shoot this turn.
- `aggression`: stance (less kiting) and a lower retreat threshold.
- Bardic Inspiration: the die rescues a missed attack or (new) a failed
  saving throw, spent only when it can still help.

## 0.3.0 → 0.4.0: encounter groups and control spells

| class | score 0.3.0 | wins 0.3.0 | score 0.4.0 | wins 0.4.0 |
|---|---|---|---|---|
| barbarian | 98.4 | 6 | 127.0 | 15 |
| bard | 43.5 | 0 | 70.9 | 4 |
| cleric | 74.7 | 0 | 125.8 | 14 |
| druid | 46.4 | 0 | 79.8 | 7 |
| fighter | 127.4 | 13 | 152.7 | 22 |
| monk | 96.9 | 6 | 95.3 | 8 |
| paladin | 105.5 | 7 | 123.2 | 13 |
| ranger | 70.1 | 1 | 87.4 | 8 |
| rogue | 82.0 | 3 | 92.5 | 8 |
| sorcerer | 60.3 | 1 | 64.4 | 2 |
| warlock | 53.1 | 0 | 81.7 | 4 |
| wizard | 66.8 | 2 | 74.6 | 4 |

- Every class now clears floor 10 with its baseline genome (109 of 384 runs,
  was 39); bard, cleric, druid and warlock had never won.
- Best / worst: 152.7 / 64.4 = **2.37×** (was 2.9×). On 64 hold-out seeds
  (not the benchmark's) the spread is 2.01× and every class wins at least
  7 runs, so the change is not tuned to the 32 benchmark seeds.
- Fights: 1.5 foes per fight solo (was 1.0), up to 3; packs grow with the
  party size.

### Telemetry (0.4.0)

| class | score | wins | depth | char lvl | fights | foes / fight | idle / retreat turns | surprised turns | slots | potions | top killers |
|---|---|---|---|---|---|---|---|---|---|---|---|
| barbarian | 127.0 | 15 | 9.1 | 8.4 | 13.2 | 1.48 | 1% / 0% | 13% | 0.0 | 1.09 | troll 13, giant-spider 1, cultist 1 |
| bard | 70.9 | 4 | 7.0 | 6.7 | 8.9 | 1.56 | 1% / 0% | 7% | 25.4 | 1.50 | ogre 6, giant-spider 6, troll 4 |
| cleric | 125.8 | 14 | 9.2 | 8.4 | 13.4 | 1.48 | 2% / 0% | 7% | 41.8 | 1.78 | troll 13, ogre 2, orc-warlord 1 |
| druid | 79.8 | 7 | 7.0 | 6.8 | 9.1 | 1.54 | 1% / 0% | 6% | 19.1 | 1.16 | giant-spider 6, orc 5, troll 4 |
| fighter | 152.7 | 22 | 9.6 | 9.1 | 14.4 | 1.46 | 1% / 0% | 10% | 0.0 | 0.69 | troll 9, giant-spider 1 |
| monk | 95.3 | 8 | 8.0 | 7.7 | 11.3 | 1.51 | 1% / 0% | 8% | 0.0 | 1.53 | troll 11, giant-spider 4, orc-warlord 3 |
| paladin | 123.2 | 13 | 9.2 | 8.4 | 13.4 | 1.48 | 1% / 0% | 9% | 5.4 | 0.88 | troll 13, orc-warlord 3, giant-spider 2 |
| ranger | 87.4 | 8 | 7.4 | 7.3 | 10.4 | 1.52 | 0% / 0% | 11% | 14.9 | 1.25 | troll 7, orc 4, giant-spider 4 |
| rogue | 92.5 | 8 | 7.8 | 7.5 | 11.0 | 1.52 | 2% / 0% | 11% | 0.0 | 1.88 | troll 11, orc 2, wight 2 |
| sorcerer | 64.4 | 2 | 6.9 | 6.6 | 9.3 | 1.54 | 0% / 0% | 13% | 16.6 | 1.66 | troll 8, giant-spider 5, bugbear 5 |
| warlock | 81.7 | 4 | 7.8 | 7.3 | 11.1 | 1.53 | 1% / 0% | 11% | 12.3 | 1.88 | troll 9, giant-spider 6, wight 3 |
| wizard | 74.6 | 4 | 7.3 | 7.0 | 9.5 | 1.55 | 1% / 0% | 12% | 17.6 | 1.50 | troll 8, giant-spider 7, ogre 3 |

### What changed (all within SRD 5.1)

- **Encounter groups.** The generator places packs: a leader plus followers
  (mostly its own kind) within 2 tiles of it — small fry (≤ 15 HP) up to 3,
  CR 1-ish foes up to 2, big ones alone, +1 per extra party member. Leaders
  stay 7 tiles apart; a spotted pack is fought together. The number of
  bodies per level is unchanged, so fights are fewer but bigger.
- **Conditions.** *Paralyzed* (Hold Person), *unconscious* (Sleep; damage
  wakes) and *incapacitated* (Hypnotic Pattern; damage ends it): the creature
  loses its turn; paralyzed / unconscious creatures fail STR and DEX saves,
  are attacked with advantage and take a crit from any melee hit within 5 ft.
- **Concentration.** Hold Person, Hypnotic Pattern, Conjure Animals and
  Hunter's Mark need it; damage forces a CON save (DC 10 or half the damage),
  0 HP or incapacitation ends it, and so does having nothing left to hold
  (every target saved or died); a new concentration spell replaces the old
  one. Effects end with it.
- **New spells.** Sleep (5d8 + 2d8/level HP of creatures, lowest first,
  undead immune), Hold Person (+1 humanoid per level above 2nd, WIS save at
  the end of each turn), Hypnotic Pattern, Conjure Animals (two dire wolves,
  ×2 from a 5th-level slot; they fight on the caster's side right after it
  and leave with the fight) and Hunter's Mark (bonus action, +1d6 on weapon
  hits, moves for free when the quarry drops).
- **Spellcasting fidelity.** "At Higher Levels" upcasting (warlock Pact slots
  finally add their dice); Scorching Ray and Eldritch Blast fire separate
  rays/beams with their own attack rolls; Healing Word is a bonus action
  (the action is then a cantrip or weapon attack).
- **Class features.** Repelling Blast (warlock 5: each beam pushes 10 ft),
  Dark One's Blessing (Fiend: temp HP = CHA + warlock level on a kill),
  Natural Recovery (Land druid: slots worth half the druid level once per
  long rest), temporary hit points.
- **Bot policy.**
  - Control spells are cast when they take more enemy HP out of the fight
    than two turns of the bot's best slot-free attack (`bot/tactics`).
  - Area spells are weighed by the foes they would catch.
  - Damage is capped at the target's HP, so a slot is not spent to overkill.
  - Self-healing happens only when the heal outpaces the damage coming in.
  - Sleepers are left alone while others are awake; helpless foes in reach
    draw melee.
  - After a shot, the bot steps back out of reach.
  - A support bot picks downed party-mates back up.
- **Fight end.** A side with every member dead or down-and-stable (and no
  summons) loses at once instead of waiting for the round cap.
- **Baseline genome.** The default `exploreCoverage` gene is 0.4 (was 0.65):
  with groups, sweeping most of a level costs more than its XP returns. On
  the hold-out seeds this raised every class (the weakest most).

### Still open

- Sorcerer and bard are the weakest classes (fragile and low on damage
  without their big slots); sorcerer subclass features beyond Draconic
  Resilience are not modelled.
- Trolls end most strong runs on floor 9.
- No opportunity attacks, so kiting never has to account for them;
  Repelling Blast pushes creatures of any size (there is no size model).

## 0.2.0 → 0.3.0

### What was killing the bots (0.2.0)

| class | score | depth | char lvl | fights | foes / fight | turns spent retreating | turns lost to surprise | slots spent | top killers |
|---|---|---|---|---|---|---|---|---|---|
| barbarian | 38.2 | 5.2 | 6.3 | 11.7 | 1.0 | 4% | 28% | 0 | troll, giant spider, dire wolf |
| bard | 9.6 | 2.9 | 5.1 | 5.2 | 1.0 | 19% | 18% | 6.9 | dire wolf, giant spider, orc |
| cleric | 27.9 | 4.3 | 5.8 | 9.5 | 1.0 | 6% | 18% | 12.8 | orc, troll, ogre |
| druid | 9.7 | 2.9 | 5.2 | 5.1 | 1.0 | 5% | 20% | 9.9 | giant spider, dire wolf |
| fighter | 58.4 | 6.8 | 7.4 | 16.9 | 1.0 | 5% | 22% | 0 | troll (19 of 32) |
| monk | 17.9 | 3.5 | 5.5 | 7.2 | 1.0 | 15% | 22% | 0 | giant spider, dire wolf |
| paladin | 45.7 | 5.8 | 6.7 | 13.5 | 1.0 | 11% | 21% | 12.0 | troll (16 of 32) |
| ranger | 19.3 | 3.7 | 5.4 | 7.0 | 1.0 | 3% | 21% | 4.8 | giant spider, dire wolf |
| rogue | 2.8 | 2.3 | 5.0 | 3.8 | 1.0 | 36% | 18% | 0 | dire wolf, giant spider |
| sorcerer | 12.7 | 3.1 | 5.2 | 5.8 | 1.0 | 24% | 25% | 5.2 | dire wolf, giant spider |
| warlock | 4.3 | 2.4 | 5.0 | 4.0 | 1.0 | 10% | 27% | 3.5 | giant spider, dire wolf |
| wizard | 5.1 | 2.5 | 5.1 | 4.3 | 1.0 | 51% | 23% | 3.4 | dire wolf, giant spider |

Every death was in combat (one trap). Findings:

1. **Futile retreats.** Below the retreat threshold a lone bot backed away —
   with no opportunity attacks and no way to leave a fight the foe simply
   followed, so the bot lost its action. Wizards spent 51 % of their turns
   this way, rogues 36 %.
2. **Surprised in every fight.** Every exploration fight began with a free
   enemy round (18–28 % of the party's turns).
3. **CR 1 foes on floor 2.** Dire wolves and giant spiders sat in the floor-2
   pool; the CR 5 troll from floor 7. Fights are one-on-one, so a solo level-5
   caster met a CR 1 brute with no rest in between; strong classes hit the
   troll wall on floor 7.
4. **Non-SRD monster buffs.** The giant spider's bite imposed *poisoned*
   (disadvantage) for 3 rounds and Web was usable every turn; the SRD has
   poison damage with a CON save and Web on Recharge 5–6.
5. **Missing SRD class features.** Rogues had no Sneak Attack, monks no
   Martial Arts, druids no Wild Shape, rangers no Hunter's Prey, wizards no
   Mage Armor / Magic Missile, warlocks no Agonizing Blast; Scorching Ray had
   one ray instead of three; spells could not use higher slots (a warlock's
   3rd-level Pact slots could never cast 1st/2nd-level spells).
6. **Attrition.** No rest between the fights of a floor, a long rest only
   every 5 floors, one Potion of Healing; bots healed themselves with their
   weakest heal (Healing Word) instead of Cure Wounds.

### What changed (all within SRD 5.1)

- AI: retreat only toward a living ally; self-heal with the strongest heal;
  spells use the lowest available slot ≥ their level (upcasting).
- Surprise: only if the spotting foe's Stealth (d20 + DEX) beats the party's
  best passive Perception. Saving throws use ability + class proficiency.
- Class features: Sneak Attack and Cunning Action (Hide/Dash), Martial Arts,
  Colossus Slayer, Wild Shape (Wolf / Ape / Brown Bear), Mage Armor, Agonizing
  Blast, Armor of Shadows, Song of Rest; Vampiric Touch heals, Magic Missile,
  Thunderwave, three-ray Scorching Ray; warlocks know Shatter.
- Giant spider: SRD bite (2d8 poison, CON DC 11 half); Web Recharge 5–6.
- Rests: one Hit Dice short rest after a fight per floor (if someone is below
  half HP); a long rest every 3 floors (≈ one adventuring day of 6–8 fights);
  two starting Potions of Healing.
- Encounters: monster pools ramp by CR (CR ≤ 1/2 on floors 1–4, CR 1 from 5,
  CR 2–3 from 7, CR 5 from 9); a boss floor's minions come from three tiers
  lower; depth scaling ×1.05/floor HP (was ×1.07), +1 damage per 8 floors
  (was 6).

### Result (0.3.0)

| class | score 0.2.0 | score 0.3.0 | wins 0.3.0 | trained (30 gen) | trained wins |
|---|---|---|---|---|---|
| barbarian | 38.2 | 98.4 | 6 | 95.8 | 6 |
| bard | 9.6 | 43.5 | 0 | 49.5 | 0 |
| cleric | 27.9 | 74.7 | 0 | 91.3 | 3 |
| druid | 9.7 | 46.4 | 0 | 54.5 | 0 |
| fighter | 58.4 | 127.4 | 13 | 143.3 | 18 |
| monk | 17.9 | 96.9 | 6 | 108.4 | 10 |
| paladin | 45.7 | 105.5 | 7 | 114.7 | 10 |
| ranger | 19.3 | 70.1 | 1 | 108.0 | 8 |
| rogue | 2.8 | 82.0 | 3 | 95.9 | 7 |
| sorcerer | 12.7 | 60.3 | 1 | 61.6 | 0 |
| warlock | 4.3 | 53.1 | 0 | 56.0 | 0 |
| wizard | 5.1 | 66.8 | 2 | 60.1 | 0 |

- Best / worst baseline: 127.4 / 43.5 = **2.9×** (was 58.4 / 2.8 ≈ 21×).
- Training: `node dist/cli.mjs train --class C --generations 30 --seed 1`
  (population 8, 12 seeds per generation, then the best candidate of each
  generation re-scored on 32 hold-out seeds). 9 of 12 classes improved on the
  benchmark; the barbarian and wizard picks did not transfer.

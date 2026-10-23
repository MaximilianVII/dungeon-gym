# Balance pass (CORE_VERSION 0.2.0 → 0.3.0)

All numbers: the official benchmark (32 fixed seeds × 10 floors, outcome-only
reward), baseline genome of each class, solo. Reproduce with
`node dist/cli.mjs report` (telemetry) and `node dist/cli.mjs bench`.

## What was killing the bots (0.2.0)

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

## What changed (all within SRD 5.1)

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

## Result (0.3.0)

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
- Baseline wins: 8 of 12 classes (39 of 384 runs); bard, cleric, druid and
  warlock still never clear floor 10 with the baseline genome (the trained
  cleric does).
- Training: `node dist/cli.mjs train --class C --generations 30 --seed 1`
  (population 8, 12 seeds per generation, then the best candidate of each
  generation re-scored on 32 hold-out seeds). 9 of 12 classes improve on the
  benchmark (ranger +38, cleric +17, fighter +16, rogue +14, monk +12); the
  barbarian (−2.6) and wizard (−6.7) picks did not transfer, sorcerer and
  warlock barely moved. Curves: `--curve` writes generation, best and
  population mean.

## Still open

- Bard, druid and warlock never win solo; the next SRD levers are control
  spells (Hold Person / Sleep need a paralysis/sleep model), Conjure Animals,
  and Repelling Blast.
- Wizard/barbarian/sorcerer/warlock training is noise-limited at this budget:
  more seeds per generation (or a larger population) is the next step.
- Fights are almost always one-on-one (enemy spacing); larger encounters would
  make AoE spells and party roles matter more.

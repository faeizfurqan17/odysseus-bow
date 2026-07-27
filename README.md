# The Bow of Odysseus

A realistic, 3D interactive recreation of Odysseus's bow — built in the spirit of Christopher Nolan's grounded, practical filmmaking. String it by hand, draw it back, and loose the shot down a torchlit megaron hall.

**Live demo:** [odysseus-bow.vercel.app](https://odysseus-bow.vercel.app/)

---

## What it is

No suitor could string this bow. Twelve axe heads stand in a line down the length of the hall, and the shot has to pass clean through every socket. This project turns that moment into something you actually do with your hands, not something you watch happen:

1. **Brace the bow** — tap a steady rhythm to build tension until the string seats into the nock.
2. **Draw the bow** — scroll, pinch, or drag to pull the camera back as the limbs bend, mirroring the way Nolan pulls his camera out for a wide release shot.
3. **Loose the shot** — let go at full draw and watch the arrow fly the length of the hall into the timber beyond the axe heads.

Along the way you can pluck the string, strike three tuned piano notes by hand, and sit by the hearth on the title screen before you ever pick up the bow.

## Controls

| Input | Action |
|---|---|
| **Spacebar** (rapid, rhythmic taps) | Build tension while bracing the bow |
| **On-screen Brace button** (touch devices) | Same tap rhythm, for mobile |
| **Scroll wheel / trackpad pinch-out / drag** | Draw the bow back, pulling the camera wide |
| **Release the gesture** or **Enter** | Loose the arrow |
| **A / S / D** | Strike the bow's three piano notes (C4, F4, A4) by hand |
| **P** (or the Pluck String button) | Pluck the string directly |
| **F** | Force-seat the string (skip the rhythm game, for testing the draw) |
| **R** | Reset the bow |
| **M** | Mute / unmute |
| **`` ` ``** | Toggle the perf/debug readout |

## How it's built

- **Three.js** — procedurally built bow geometry (wood riser, horn tips, leather grip, bronze fittings), a skeleton/bone rig for the string and limb bend, PBR materials, a stone megaron hall with a colonnade and axe-head targets, GPU-instanced dust, and a post-processing chain (bloom, film grain, depth-aware focus, camera shake).
- **Web Audio API** — every continuous sound (creak, structural strain, draw groan) is synthesized in real time from filtered noise so it tracks tension and draw as continuous values, not crossfaded clips. Impulsive sounds (the seat clunk, the release, the impact) are real recordings layered and randomized so repeated hits never sound identical.
- **No build step** — plain ES modules loaded via import map. Open `index.html` and it runs.

### Sound design

Sourced after researching the actual sound palette of Christopher Nolan's *The Odyssey* (2026), which was built on bronze gongs, struck scrap metal, and a lyre standing in for the bow's pluck rather than a synthesized score. This project doesn't use a synth pad or sustained oscillator anywhere — every layer is either a real recording or filtered noise shaped to track the physics of the bow.

The bow's three playable notes (A / S / D → C4, F4, A4) are real piano recordings, in tune with each other and left untransposed.

## Running it locally

No build tooling required.

```bash
git clone https://github.com/faeizfurqan17/odysseus-bow.git
cd odysseus-bow
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works — the project is plain HTML/CSS/JS with an import map, no bundler.

## Deployment

Deployed on [Vercel](https://vercel.com) as a static site. No framework preset, no build command, no output directory — just serve the repo root as-is. If you fork this, make sure Vercel's **Root Directory** setting is left at the repo root (not `src/`), since `index.html` and `assets/` live there alongside `src/`.

## Audio credits

All sound effects are sourced from [Freesound.org](https://freesound.org). Most are CC0 (no attribution required); two are CC BY and are credited below as their license requires.

| File(s) | Sound | Author | License |
|---|---|---|---|
| `gong-1` – `gong-5` | Gong hits | BOSS MUSIC, nkuitse, DiArchangeli, pumodi, ceich93 | CC0 |
| `creak-1` – `creak-4` | Wood/rope creaks | Mafon2, Department64, Rudmer_Rotteveel, ssierra1202 | CC0 |
| `bowdraw-1` | Bow Drawn | Paveroux | CC0 |
| `release-1` – `release-3` | Bow release | Ali_6868, saturdaysoundguy, JoeDinesSound | CC0 |
| `whoosh-1` – `whoosh-3` | Arrow flyby | saturdaysoundguy, Kinoton, qubodup | CC0 |
| `impact-1` – `impact-4` | Arrow/wood impact | Twisted_Euphoria, Ali_6868, dleigh, Breviceps | CC0 |
| `metal-1` – `metal-3` | Anvil/metal hits | michorvath, plamdi1 | CC0 |
| `piano-f`, `piano-a`, `piano-c` | Piano notes F / A / C | pinkyfinger | CC0 |
| `fire-loop` | Hearth fire (title screen) | wwstudioswastaken, *Fire_Burning_03.flac* | CC0 |
| `bowshot-release`, `bowdraw-2` | *CR BowAndArrowStereo.wav* (trimmed) | [cmusounddesign](https://freesound.org/people/cmusounddesign/sounds/126298/) | CC BY 4.0 |
| `pluck-1` | *Piano string plucked.wav* | [NEDDYBLOWER](https://freesound.org/people/NEDDYBLOWER/) | CC BY 3.0 |

## License

Code in this repository is available for personal and educational use. Audio assets remain under their original Freesound licenses as listed above.

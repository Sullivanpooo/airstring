# AIRSTRING

A browser-based virtual string instrument you play with your hands, using only a webcam.

## How it works

- **Place a string:** pinch thumb and index finger on both hands, then release.
- **Resize or move it:** pinch near an end dot and drag. Pinch both ends to move the whole string.
- **Pluck it:** flick a finger across the string.
- **Pluck mode:** point with your index finger and hold to enter. Make a fist to exit.
- **Pitch:** a shorter string plays a higher note.

## Keys

| Key | Action |
|---|---|
| C | Clear all strings |
| Z | Remove the last string |
| P | Toggle pluck mode |
| M | Mute / unmute |
| T | Play a test note |

## Run it locally

The camera only works over `localhost` or HTTPS, so don't open `index.html` directly.

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000 in Chrome or Edge.

## Built with

HTML, CSS, vanilla JavaScript, MediaPipe Hand Landmarker, the Canvas API and the Web Audio API (Karplus-Strong synthesis). No backend, no frameworks.
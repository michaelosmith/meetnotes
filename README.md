# MeetNotes (MVP)

Private meeting transcription for Edge on Windows. Audio and transcripts stay on your laptop. Whisper runs inside the browser (on your GPU via WebGPU when it can, otherwise on the CPU).

## Run it

1. Right-click the zip, choose **Properties**, tick **Unblock**, then extract.
2. Double-click `start.cmd`. Edge opens at http://localhost:8787.
3. First run downloads the model (Base is about 200 MB) and caches it.
4. In Edge, use **... > Apps > Install this site as an app**. After that it opens from the Start menu, even without `start.cmd` running.

If WDAC/AppLocker blocks the script, use `npx serve -l 8787` in the folder instead.

## Use it

- **Online call (Teams, Zoom, Meet):** leave **System audio** ticked. When Edge asks, pick **Entire screen** and turn on **Share system audio**. Wear headphones, or your mic will also pick up the other side.
- **In-person meeting:** untick **System audio**. The mic is labelled **Room**.
- Tick **Participants informed**, then press **Start**.
- Type notes in the right-hand box during the meeting. Press Enter and each one is stamped with the meeting time.
- Click any transcript line to correct it.
- **Copy for AI** copies a summarising prompt with your notes and transcript, ready to paste into Claude or Copilot (v2 will do this automatically).
- **Audio** downloads the recording as stereo WebM: left = you, right = them. Keep it if you want to re-run it later through a better model or Azure Speech.

## Models

| Model | Notes |
|---|---|
| Tiny | Fast on any laptop, rougher |
| Base | Default, good balance |
| Small | Best accuracy, wants a decent GPU |

If the status bar says it's falling behind, switch to a smaller model. The status bar shows whether it's running on GPU or CPU.

## Known limits (MVP)

- Speakers are only separated into Me/Them/Room, with no per-person diarisation yet.
- Edge asks for screen-share permission each meeting.
- Data lives in this Edge profile's storage. Export anything you want to keep long-term.

## Files

`index.html` UI, `app.js` capture, segmentation, storage and export, `worker.js` Whisper, `capture-worklet.js` audio tap, `sw.js` offline/PWA, `serve.ps1` local server.

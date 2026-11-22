# MeetNotes v1.2

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
- **Copy for AI** copies a summarising prompt with your context, notes and transcript, ready to paste into Claude or Copilot. Your notes appear in the transcript at the moment you typed them (📝).
- **Audio** downloads the recording as stereo WebM: left = you, right = them. Keep it if you want to re-run it later through a better model or Azure Speech.

## Settings (⚙)

Settings are stored in this browser only. They're never put in the repo, so keep your own lists out of the code.

- **Glossary:** a plain line like `Conditional Access` teaches the spelling. A line like `conditional excess | conditional axis -> Conditional Access` auto-fixes new transcript lines. **Apply fixes to this meeting** runs the fixes over a meeting you've already recorded. Fixes are blunt find-and-replace, so avoid everyday phrases (e.g. `in tune -> Intune` would also change "in tune with").
- **People:** `Name = role`. Used for spelling, and to help the AI pick action owners.
- **About me:** added to every Copy for AI prompt.
- **Experimental steering:** passes the glossary terms and names to Whisper as a prompt. If the model doesn't support it, it turns itself off and says so in the status bar. If you see glossary words turning up in silence, switch it off.
- **Export / Import settings** moves your settings between browsers or laptops as a JSON file.

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

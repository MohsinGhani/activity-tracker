# Activity Tracker

An Electron desktop app that tracks work sessions with periodic screenshots,
active-app/window detection, and idle detection. Auth and storage are backed by
Firebase; screenshots are uploaded to Cloudinary.

## Requirements (macOS)

The app cannot start a session unless **both** of these macOS permissions are
granted (System Settings → Privacy & Security):

| Permission          | Used for                                   |
| ------------------- | ------------------------------------------ |
| **Screen Recording**| Capturing screenshots **and** reading window titles for the App Breakdown |
| **Accessibility**   | Enumerating the active app / open windows  |

> **Input Monitoring is NOT required.** Idle detection uses
> `powerMonitor.getSystemIdleTime()`, which on macOS relies on
> `CGEventSourceSecondsSinceLastEventType` — an API that works without Input
> Monitoring permission. (Probing that permission via idle samples is also
> unreliable: idle time reads 0 both when the permission is missing *and* when
> the user is actively typing/moving the mouse, so it is intentionally not
> gated.)

> **Relaunch note:** On macOS, a *freshly granted* Screen Recording permission
> does not take effect for a running app. The tracker detects this state and
> shows a **"Relaunch now"** banner — screenshots and activity tracking work
> after the relaunch.

If a screenshot fails, the real error is shown in a toast and in a **Last error**
panel on the dashboard, and is written to a log file you can open with the
**Open log** button (stored at `<userData>/logs/tracker.log`).

## Sessions & Remember me

- Tick **Remember me** on the login screen to stay signed in across app restarts
  (Firebase local persistence) and to prefill your email next time.
  **Your password is never stored.**
- Unticking it signs you out when the app closes and clears the saved email.
- There is **no timed auto-logout.** Sessions roll over at 23:59 (a new session
  starts at 00:00), but you are never logged out on a timer.

## Idle detection

Idle detection is **purely input-based** — it reacts to keyboard and mouse
activity only. It has no awareness of what is on screen or whether audio/video
is playing.

- **Threshold:** **15 minutes** of no keyboard/mouse input.
- **Signal:** `powerMonitor.getSystemIdleTime()` on macOS/Linux (seconds since
  last input); on Windows the equivalent via `GetLastInputInfo`.
- **Polling:** the renderer checks idle time every **10 seconds** while a
  session is active.
- **Auto-pause:** at ≥ 15 minutes idle the session pauses, screenshots stop, and
  the away time is counted as idle.
- **Auto-resume:** the first keyboard/mouse input resumes the session and the
  full away duration is recorded as idle.
- **Power events:** `suspend`, `lock-screen`, and `display-sleep` pause
  immediately (before the 15-minute mark); `resume`, `unlock-screen`, and
  `display-on` resume.
- **Reported time:** active time = elapsed − idle. "Today's Active Time"
  excludes idle periods.

### Watching a video counts as idle

Because detection only watches keyboard/mouse input, **watching a long video
with no input is treated as idle after 15 minutes**, even though you are
actively watching. For example, a 30-minute tutorial watched without touching
the mouse or keyboard will be marked idle at the 15-minute point and the session
will pause.

**Workaround:** move the mouse or press a key occasionally during long videos to
stay counted as active.

## Development

```bash
npm install
npm start
```

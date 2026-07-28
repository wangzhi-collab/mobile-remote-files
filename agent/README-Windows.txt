Phone Remote Agent for Windows
==============================

What it does
------------
This app connects your PC to your deployed Mobile Remote Files server. After it
starts, it opens a pairing window with a 6-digit PIN. Open the website on your
phone and enter that PIN to browse, search, and download files from this PC.

Configure the server
--------------------
Pass your server URL when starting the agent:

PhoneRemoteAgent.exe https://your-domain.example

You can also set this environment variable before launching:

PHONE_REMOTE_SERVER_URL=https://your-domain.example

Quick start
-----------
1. Double-click PhoneRemoteAgent.exe, or launch it with your server URL.
2. Wait for the pairing window to show a PIN.
3. Open your deployed website on your phone.
4. Enter the PIN.

Large downloads
---------------
Large files download in the background. Keep this window open; the phone page
can continue browsing or refreshing while the file is being transferred.

Background mode
---------------
Closing the pairing window hides it to the Windows tray and keeps the agent
running. Double-click the tray icon to show the PIN again. Use "Stop and Exit"
from the tray menu or the red X button in the window to stop the agent.

Logs
----
Click "Logs" in the app window or tray menu to view connection and download
logs. The log file is stored under the current user's local app data folder.

Security
--------
The agent is read-only. It does not delete, upload, move, or execute files.

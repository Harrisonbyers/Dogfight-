# Dogfight - multiplayer

A single-file browser dogfight game (Three.js) plus a zero-dependency Node
server that lets pilots share a room. Play on the same page the server hosts,
or host the page on GitHub Pages and point it at the server.

## How multiplayer works

- Pilots who enter the same room code fly in the same sky. The server splits
  them into Blue and Red automatically and uses the first pilot's map, year,
  time and weather for the room.
- Each browser simulates its own aircraft and sends its position about 15 times
  a second. Guns, hits and deaths are relayed by the server.
- Online mode is team deathmatch. There are no AI enemies, and there is no
  pause. Missiles work but other pilots do not see them in flight.
- Up to 12 pilots per room.

## Run it on your computer

    node server.js

Open http://localhost:8080 in two browser tabs, press **Play online** in both
with the same room code.

## Put it online with GitHub and Render

1. Create a new GitHub repository and push these files to it
   (index.html, server.js, package.json, render.yaml).
2. On https://render.com choose **New > Blueprint** (or **New > Web Service**),
   connect the repository and deploy.
   - Blueprint: Render reads `render.yaml`.
   - Web Service by hand: Runtime Node, Build command `echo ok`,
     Start command `node server.js`, Health check path `/health`, plan Free.
3. Open your Render address, for example https://dogfight.onrender.com.
   The game page and the server are the same service, so the Server box fills
   itself in. Share the address and a room code with friends.

The free Render plan puts the service to sleep after about 15 minutes without
visitors. The first connection after that can take up to a minute.

### Optional: host the page on GitHub Pages

In the repository go to Settings > Pages, choose "Deploy from a branch", branch
`main`, folder `/ (root)`. Then open

    https://YOUR-NAME.github.io/YOUR-REPO/?server=your-app.onrender.com

The page remembers the server address after the first visit.

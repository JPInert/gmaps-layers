# Google Maps Layers

A userscript that answers a question Google Maps can't: **"show me X within N miles of each Y."**

> **Status: in testing.** It works and I use it, but it is still being tested and changed. Google can change the endpoint it reads at any time, which would break searches until it is updated.

Superchargers with food within half a mile. Hotels with a dog park within a mile. Gas stations with coffee next door. Maps can search for one thing at a time; this runs both searches, measures the distance from every Y to every X, and draws the result on the map.

## What it does

- **Anchor + finds.** One anchor search (the Y: "tesla supercharger") and one or more find searches (the X: "food", "coffee"), each in its own colour.
- **Hubs.** Every anchor result becomes a hub with a radius disc on the map. Each hub lists the finds inside its radius, nearest first.
- **Filters**, applied live: radius (0.25 to 5 mi), minimum stars, minimum review count, and "open now / open within 1, 2 or 4 hours", worked out from each place's opening hours.
- **Bottom sheet built for the car.** A swipe-up sheet of hubs with photo cards and big touch targets, sorted by distance from home (if you set one) or from the map centre. One tap opens directions.
- **Presets**: Superchargers + food, Superchargers + coffee, Hotels + dog parks, Gas + coffee.

## How it works

The script reads the same search endpoint the Maps page itself calls when you type in the search box, so results match what Maps would show you. Nothing is sent anywhere else.

- **Paging**: Maps returns 20 results a page, ranked by relevance rather than distance, so in-range places turn up on late pages. Each search fetches pages five at a time until one comes back empty. Stopping at the first page with nothing new had kept only 33 of 54 food places within 0.5 mi.
- **Relevance trimming**: Maps pads results with loosely related places ("dog park" returns a sports bar). Category-like queries (coffee, pizza, gas station) match 76-97% of results by name or category; free-text ones (food, tacos) only 28-45%, where the rest are real answers. So results are trimmed only when more than 75% match, or when the query is in quotes. Measured on 2 areas, n=120-202 results each.
- **Payload**: the request carries a protobuf-style parameter blob. Cutting it to only the groups the script reads took a page of results from 811 kB to 510 kB while keeping name, coordinates, rating, reviews, category, photo, hours and price.
- **Rate limits**: at most 8 requests in flight and 20 hubs per run, and results are cached for 30 minutes per query and area. A 429, or Google's "unusual traffic" page, stops the run with a message instead of retrying.
- **Code layout**: one file in sections (CONST, PURE, STORE, API, ENGINE, MAP, UI, BOOT). PURE holds the distance, opening-hours and relevance logic with no DOM, so it can be tested under Node.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or Tampermonkey.
2. Open `gmaps-layers.user.js` here, click **Raw**, and confirm the install.
3. Open [Google Maps](https://www.google.com/maps) and use the sentence bar at the top.

Settings and an optional home location are kept in your browser's localStorage. Nothing leaves the page except the Maps searches themselves.

## A note on Google's terms

This uses an undocumented endpoint, not the paid Places API, and Google's terms don't allow automated access to Maps. It is a personal tool: read-only, rate-limited, and it runs only in a browser where you are already using Maps. Use it the same way.

## Built with Claude Code

I designed and built this with Claude Code as my pair, including the request capture, the payload trimming and the relevance measurements above.

## License

MIT

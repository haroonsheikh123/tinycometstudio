---
title: "Project Nova devlog #1: finding the fun"
date: 2026-11-05
category: Devlog
author: haroon-sheikh
excerpt: "PLACEHOLDER — An example devlog post that shows headings, lists, code, images and a YouTube embed."
cover: ""
game: project-nova
placeholder: true
---

==PLACEHOLDER POST — this sample shows every formatting option the news system supports. Replace or delete it.==

Every game starts with a tiny question: *what's the one thing that feels good to do, over and over?* For Project Nova, that's steering a little comet through a sky full of stars.

## The first prototype

The first build was just a circle that followed your finger. Then we added:

1. A trail that stretches when you move fast
2. Stars that sparkle when you catch them
3. A *very* satisfying little "pop" sound

### A peek at the code

Inline code looks like `catchStar(star)`, and blocks look like this:

```js
function catchStar(star) {
  score += 1;
  sparkle(star.x, star.y);
}
```

## Pictures and video

Images use normal Markdown syntax:

![Placeholder screenshot](/assets/games/stardust-notes/shot-2.svg)

And a YouTube video can be embedded with a shortcode on its own line, like `{{youtube https://www.youtube.com/watch?v=VIDEO_ID}}`. (Left out here because this is a placeholder.)

> Tip: you can try a tiny demo of the idea right now with the **Play in browser** button on the [Project Nova page](/project-nova/).

/* Catch-all so every /<slug>/play/* request runs through _middleware.js in this folder.
   Once the middleware lets a request through, hand it to the static asset server. */
export const onRequest = (context) => context.next();

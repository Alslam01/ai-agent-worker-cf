export default {
  async fetch() {
    return new Response("AI Agent working", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

DOMinAItrix.defineAdapter({
  meta: {
    id: "example-com",
    version: "0.1.0",
    route: "/",
  },
  tools: [
    {
      name: "inspect_example_page",
      description: "Return the visible heading and destination link from the Example Domain page.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async (_args, { ctx }) => {
        const heading = ctx.dom.required("h1").textContent.trim();
        const link = ctx.dom.required("a[href]");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ heading, link: link.href }),
          }],
        };
      },
    },
  ],
});

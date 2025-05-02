# Steel MCP Server

[![smithery badge](https://smithery.ai/badge/@steel-dev/steel-mcp-server)](https://smithery.ai/server/@steel-dev/steel-mcp-server)

https://github.com/user-attachments/assets/25848033-40ea-4fa4-96f9-83b6153a0212


A Model Context Protocol (MCP) server that enables LLMs like Claude to navigate the web through Puppeteer-based tools and Steel. Based on the Web Voyager framework, it provides tools for all the standard web actions click clicking/scrolling/typing/etc and taking screenshots.

Ask Claude to help you with tasks like:
- "Search for a recipe and save the ingredients list"
- "Track a package delivery status"
- "Find and compare prices for a specific product"
- "Fill out an online job application"

<a href="https://glama.ai/mcp/servers/tbd32geble"><img width="380" height="200" src="https://glama.ai/mcp/servers/tbd32geble/badge" alt="Steel Server MCP server" /></a>

## 🚀 Quick Start

Below is a streamlined guide to run Steel Voyager inside Claude Desktop. You only need to adjust the environment options to switch between Steel Cloud and a local/self-hosted instance.

### Prerequisites

1. Latest versions of Git and Node.js installed
2. [Claude Desktop](https://claude.ai/download) installed
3. (Optional) [Steel Docker image](https://github.com/steel-dev/steel-browser) running locally, if you plan to self-host
4. (Optional) If running Steel Cloud, bring your API key. Get one [here](https://app.steel.dev/settings/api-keys).

---

### A) Quick Start (Steel Cloud)

1. Clone and build the project:

   ```bash
   git clone https://github.com/steel-dev/steel-mcp-server.git
   cd steel-mcp-server
   npm install
   npm run build
   ```

2. Configure Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) by adding a server entry:

   ```json
   {
     "mcpServers": {
       "steel-puppeteer": {
         "command": "node",
         "args": ["path/to/steel-voyager/dist/index.js"],
         "env": {
           "STEEL_LOCAL": "false",
           "STEEL_API_KEY": "YOUR_STEEL_API_KEY_HERE",
           "GLOBAL_WAIT_SECONDS": "1"
         }
       }
     }
   }
   ```

   - Replace "YOUR_STEEL_API_KEY_HERE" with your valid Steel API key.
   - Make sure "STEEL_LOCAL" is set to "false" for cloud mode.

3. Start Claude Desktop. It will automatically launch this MCP server in Cloud mode.

4. (Optional) You can view or manage active Steel Browser sessions in your [dashboard](https://app.steel.dev).

---

### B) Quick Start (Local / Self-Hosted Steel)

1. Ensure your local or self-hosted Steel service is running (e.g., using the open-source Steel Docker image).

2. Clone and build the project (same as above if not done yet):

   ```bash
   git clone https://github.com/steel-dev/steel-mcp-server.git
   cd steel-mcp-server
   npm install
   npm run build
   ```

3. Configure Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) for local mode:

   ```json
   {
     "mcpServers": {
       "steel-puppeteer": {
         "command": "node",
         "args": ["path/to/steel-voyager/dist/index.js"],
         "env": {
           "STEEL_LOCAL": "true",
           "STEEL_BASE_URL": "http://localhost:3000",
           "GLOBAL_WAIT_SECONDS": "1"
         }
       }
     }
   }
   ```

   - "STEEL_LOCAL" must be "true".
   - If self hosting on a cloud server, configure "STEEL_BASE_URL" to point to your local/self-hosted Steel URL.

4. Start Claude Desktop, which will connect to your locally running Steel and launch Steel Voyager in local mode.

5. (Optional) To view sessions locally, you can visit your self-hosted dashboard ([localhost:5173](http://localhost:5173/)) or logs specific to your Steel runtime environment.

---

That’s it! Once Claude Desktop starts, it will orchestrate the MCP server behind the scenes and let you interact with the web automation capabilities through Steel Voyager.

For more info on getting set up or if you're having issues, check out the MCP set-up docs: https://modelcontextprotocol.io/quickstart/user

## Components

### Tools

- **navigate**

  - Navigate to any URL in the browser
  - Inputs:
    - `url` (string, required): URL to navigate to (e.g. "https://example.com").

- **search**

  - Perform a Google search by navigating to "https://www.google.com/search?q=encodedQuery".
  - Inputs:
    - `query` (string, required): Text to search for on Google.

- **click**

  - Click elements on the page using numbered labels
  - Inputs:
    - `label` (number, required): The label number of the element to click.

- **type**

  - Type text into input fields using numbered labels
  - Inputs:
    - `label` (number, required): The label number of the input field.
    - `text` (string, required): Text to type into the field.
    - `replaceText` (boolean, optional): If true, replaces any existing text in the field.

- **scroll_down**

  - Scroll down the page
  - Inputs:
    - `pixels` (integer, optional): Number of pixels to scroll down. If not specified, scrolls by one full page.

- **scroll_up**

  - Scroll up the page
  - Inputs:
    - `pixels` (integer, optional): Number of pixels to scroll up. If not specified, scrolls by one full page.

- **go_back**

  - Navigate to the previous page in browser history
  - No inputs required

- **wait**

  - Wait for up to 10 seconds, useful for pages that load slowly or need more time for dynamic content to appear.
  - Inputs:
    - `seconds` (number, required): Number of seconds to wait (0 to 10).

- **save_unmarked_screenshot**
  - Capture the current page without bounding boxes or highlights and store it as a resource.
  - Inputs:
    - `resourceName` (string, optional): Name to store the screenshot under (e.g. "before_login"). If omitted, a generic name is generated automatically.

### Resources

- **Screenshots**:
  Each saved screenshot is accessible via an MCP resource URI in the form of:
  • `screenshot://RESOURCE_NAME`

  The server stores these screenshots whenever you specify the "save_unmarked_screenshot" tool or when an action concludes (for most tools) with an annotated screenshot. These images can be retrieved through a standard MCP resource retrieval request.

(Note: While console logs are still collected for analysis and debugging, they are not exposed as retrievable resources in this implementation. They appear in the server’s logs but are not served via MCP resource URIs.)

## Key Features

- Browser automation with Puppeteer
- Steel integration for browser session management
- Visual element identification through numbered labels
- Screenshot capabilities
- Basic web interaction (navigation, clicking, form filling)
- Lazy-loading support through scrolling
- Local and remote Steel instance support

## Understanding Bounding Boxes

When interacting with pages, Steel Puppeteer adds visual overlays to help identify interactive elements:

- Each interactive element (buttons, links, inputs) gets a unique numbered label
- Colored boxes outline the elements' boundaries
- Labels appear above or inside elements for easy reference
- Use these numbers when specifying elements for click or type operations


## Configuration

Steel Voyager can run in two modes: "Local" or "Cloud". This behavior is controlled by environment variables. Below is a concise overview:

| Environment Variable | Default                 | Description                                                                                                                                                                                                                    |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| STEEL_LOCAL          | "false"                 | Determines if Steel Voyager runs in local (true) or cloud (false) mode.                                                                                                                                                        |
| STEEL_API_KEY        | (none)                  | Required only when STEEL_LOCAL = "false". Used to authenticate requests with the Steel endpoint.                                                                                                                               |
| STEEL_BASE_URL       | "https://api.steel.dev" | The base URL for the Steel API. Override this if self-hosting the Steel server (either locally or in your own cloud environment). If STEEL_LOCAL = "true" and STEEL_BASE_URL is unset, it defaults to "http://localhost:3000". |
| GLOBAL_WAIT_SECONDS  | (none)                  | Optional. Number of seconds to wait after each tool action (for instance, to allow slow-loading pages).                                                                                                                        |

### Local Mode

1. Set STEEL_LOCAL="true".
2. (Optional) Set STEEL_BASE_URL to point to the Steel server if you host it on a custom domain. Otherwise, Steel Voyager will default to http://localhost:3000.
3. No API key is required in this mode.
4. Puppeteer will connect via ws://0.0.0.0:3000

Example:

export STEEL_LOCAL="true"

export STEEL_BASE_URL="http://localhost:3000" # only if overriding

### Cloud Mode

1. Set STEEL_LOCAL="false".
2. Set STEEL_API_KEY so Steel Voyager can authenticate with the Steel cloud service (or your self-hosted Steel if you changed STEEL_BASE_URL).
3. STEEL_BASE_URL defaults to https://api.steel.dev; override this if you have a self-hosted Steel instance running on another endpoint.
4. Puppeteer will connect via wss://connect.steel.dev?sessionId=…&apiKey=…

Example:

export STEEL_LOCAL="false"

export STEEL_API_KEY="YOUR_STEEL_API_KEY_HERE"

### Claude Desktop Configuration

To use Steel Voyager with Claude Desktop, add something like this to your config file (often located at
~/Library/Application Support/Claude/claude_desktop_config.json):

```json
{
  "mcpServers": {
    "steel-puppeteer": {
      "command": "node",
      "args": ["path/to/steel-puppeteer/dist/index.js"],
      "env": {
        "STEEL_LOCAL": "false",
        "STEEL_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Adjust the environment variables to match your desired mode:

• If running locally/self hosted, keep `"STEEL_LOCAL": "true"` and optionally `"STEEL_BASE_URL": "http://localhost:3000"`.  
• If running in cloud mode, remove `"STEEL_LOCAL": "true"`, add `"STEEL_LOCAL": "false"`, and supply `"STEEL_API_KEY": "<YourKey>"`
This will allow Claude Desktop to start Steel Voyager in the correct mode.

## Installation & Running

### Installing via Smithery

To install Steel MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@steel-dev/steel-mcp-server):

```bash
npx -y @smithery/cli install @steel-dev/steel-mcp-server --client claude
```

### Local Development

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```
4. Start the server:
   ```bash
   npm start
   ```


## Example Usage 📹

We asked Claude to impress us with it's new abilities and it decided to research the latest developments with sora then create an interactive visualization to demonstrate the data behind the model and how it works 🤯


https://github.com/user-attachments/assets/8d4293ea-03fc-459f-ba6b-291f5b017ad7

*Sorry for quality, github forces us to keep the videos under 10mb :/

## Troubleshooting

Common issues and solutions:

1. Verify your Steel API key when using cloud service and ensure your local Steel instance is running. Check that you have proper network connectivity to the service.

2. If you're having issues with how pages are being rendered or marked up and sent to claude, try to add a delay in your config via the `GLOBAL_WAIT_SECONDS` env variable.

3. Ensure the page has fully loaded and check your viewport size settings. Make sure your system has sufficient available memory for capturing screenshots.

4. Session clean up isn't the best right now so you may need to manually release sessions as they're spun up to execute tasks.

5. Prompting claude the right way can go a long way in improving performance and avoiding silly mistakes it may produce.

6. Leverage the session viewer to analyse where your model may be getting stopped out.

7. After ~15-20 browser actions claude starts to slow down as it's context window gets filled but with images. It shouldn't be horrible but we've noticed some latency here, especially with the Claude Desktop client lagging behind.

## Contributing

This project is experimental and under active development. Contributions are welcome!

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

Please include:

- Clear description of changes
- Motivation
- Documentation updates

## Disclaimer



## Running evals

The evals package loads an mcp client that then runs the index.ts file, so there is no need to rebuild between tests. You can load environment variables by prefixing the npx command. Full documentation can be found [here](https://www.mcpevals.io/docs).

```bash
OPENAI_API_KEY=your-key  npx mcp-eval src/evals/evals.ts src/index.ts
```
⚠️ This project is experimental and based on the Web Voyager codebase. Use in production environments at your own risk.

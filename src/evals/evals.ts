//evals.ts

import { EvalConfig } from 'mcp-evals';
import { openai } from "@ai-sdk/openai";
import { grade, EvalFunction } from "mcp-evals";

const navigateEval: EvalFunction = {
    name: "navigate Tool Evaluation",
    description: "Evaluates the ability to navigate to a specified URL",
    run: async () => {
        const result = await grade(openai("gpt-4"), "Please navigate to the website https://example.com and describe the steps to do so.");
        return JSON.parse(result);
    }
};

const searchEval: EvalFunction = {
    name: 'Search Tool Evaluation',
    description: 'Evaluates the functionality of the search tool',
    run: async () => {
        const result = await grade(openai("gpt-4"), "Please use the 'search' tool to look up the best coffee shops in Seattle and summarize the results.");
        return JSON.parse(result);
    }
};

const clickEval: EvalFunction = {
    name: 'click Tool Evaluation',
    description: 'Evaluates clicking a specified numbered label on the page',
    run: async () => {
        const result = await grade(openai("gpt-4"), "Click the element labeled 3 in the annotated screenshot.");
        return JSON.parse(result);
    }
};

const typeEval: EvalFunction = {
    name: "typeEval",
    description: "Evaluates the type tool's functionality of typing text into a labeled input field with optional replacement",
    run: async () => {
        const result = await grade(openai("gpt-4"), "Please type 'Hello, OpenAI!' into the input field labeled #3, ensuring any existing text is replaced.");
        return JSON.parse(result);
    }
};

const scroll_downEval: EvalFunction = {
    name: 'scroll_downEval',
    description: 'Evaluates the scroll_down tool functionality',
    run: async () => {
        const result = await grade(openai("gpt-4"), "Please scroll down the page by 250 pixels.");
        return JSON.parse(result);
    }
};

const config: EvalConfig = {
    model: openai("gpt-4"),
    evals: [navigateEval, searchEval, clickEval, typeEval, scroll_downEval]
};
  
export default config;
  
export const evals = [navigateEval, searchEval, clickEval, typeEval, scroll_downEval];
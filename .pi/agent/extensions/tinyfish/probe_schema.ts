import { FETCH_PARAMETERS } from "./params.ts";
console.log("keys:", Object.keys(FETCH_PARAMETERS));
console.log(JSON.stringify(FETCH_PARAMETERS).slice(0, 600));
console.log("required:", JSON.stringify(FETCH_PARAMETERS.required));

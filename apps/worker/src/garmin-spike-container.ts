import { Container } from "@cloudflare/containers";

// Kept for Cloudflare Durable Object migration history. The spike route was removed
// in PBI-019, but deployed migrations still require this class export to exist.
export class GarminSpikeContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
}

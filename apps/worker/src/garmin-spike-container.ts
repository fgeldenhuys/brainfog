import { Container } from "@cloudflare/containers";

export class GarminSpikeContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
}

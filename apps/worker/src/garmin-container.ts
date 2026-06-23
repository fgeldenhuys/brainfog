import { Container } from "@cloudflare/containers";

export class GarminContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
}

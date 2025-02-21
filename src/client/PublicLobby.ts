import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Lobby } from "../core/Schemas";
import { Difficulty, GameMapType, GameType } from "../core/game/Game";
import { consolex } from "../core/Consolex";
import { getMapsImage } from "./utilities/Maps";

@customElement("public-lobby")
export class PublicLobby extends LitElement {
  @state() private lobbies: Lobby[] = [];
  private lobbiesInterval: number | null = null;
  private currLobby: Lobby = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.fetchAndUpdateLobbies();
    this.lobbiesInterval = window.setInterval(
      () => this.fetchAndUpdateLobbies(),
      1000,
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.lobbiesInterval !== null) {
      clearInterval(this.lobbiesInterval);
      this.lobbiesInterval = null;
    }
  }

  private async fetchAndUpdateLobbies(): Promise<void> {
    try {
      const lobbies = await this.fetchLobbies();
      this.lobbies = lobbies;
    } catch (error) {
      consolex.error("Error fetching lobbies:", error);
    }
  }

  async fetchLobbies(): Promise<Lobby[]> {
    try {
      const response = await fetch("/lobbies");
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      return data.lobbies;
    } catch (error) {
      consolex.error("Error fetching lobbies:", error);
      throw error;
    }
  }

  public stop() {
    if (this.lobbiesInterval !== null) {
      clearInterval(this.lobbiesInterval);
      this.lobbiesInterval = null;
    }
  }

  render() {
    if (this.lobbies.length === 0) return html``;

    const lobby = this.lobbies[0];

    return html`
      <div class="grid grid-cols-3">
        ${this.lobbies.map(
          (lobby) =>
            html`
        <div @click=${() => this.lobbyClicked(lobby)} class="h-60 m-1 rounded overflow-hidden shadow-lg text-white cursor-pointer bg-black ${
          this.currLobby && this.currLobby.id == lobby.id
            ? "border-4 border-green-500"
            : "border-4 border-solid border-white-500"
        }">
          <img class="w-full h-40" src="${getMapsImage(lobby.gameConfig.gameMap)}" alt="${lobby.gameConfig.gameMap}">

          <div class="flex flex-col h-20 items-center">

                <div class="font-bold">${lobby.gameConfig.gameMap}</div>
                <p class="text-blue-500 text-base">
                  ${lobby.numClients}
                  ${lobby.numClients === 1 ? "Player" : "Players"}
                </p>
                <p class="text-green-500 text-base">
                  ${Math.max(0, Math.floor(lobby.msUntilStart / 1000))}s
                </p>
              </div>
        </div>
    </div>`,
        )}
      </div>
    `;
  }

  private lobbyClicked(lobby: Lobby) {
    if (this.currLobby && lobby.id == this.currLobby.id) {
      this.dispatchEvent(
        new CustomEvent("leave-lobby", {
          detail: { lobby: this.currLobby },
          bubbles: true,
          composed: true,
        }),
      );
      this.currLobby = null;
      return;
    }

    if (this.currLobby == null) {
      this.currLobby = lobby;
      this.dispatchEvent(
        new CustomEvent("join-lobby", {
          detail: {
            lobby,
            gameType: GameType.Public,
            map: GameMapType.World,
            difficulty: Difficulty.Medium,
          },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }
}

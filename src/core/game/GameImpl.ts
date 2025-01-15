import { Config } from "../configuration/Config";
import { Cell, Execution, MutableGame, Game, MutablePlayer, PlayerID, PlayerInfo, Player, TerraNullius, Tile, Unit, MutableAllianceRequest, Alliance, Nation, UnitType, UnitInfo, TerrainMap, DefenseBonus, MutableTile, GameUpdate, GameUpdateType, AllPlayers, GameUpdates } from "./Game";
import { NationMap, TerrainMapImpl } from "./TerrainMapLoader";
import { PlayerImpl } from "./PlayerImpl";
import { TerraNulliusImpl } from "./TerraNulliusImpl";
import { TileImpl } from "./TileImpl";
import { AllianceRequestImpl } from "./AllianceRequestImpl";
import { AllianceImpl } from "./AllianceImpl";
import { ClientID, GameConfig } from "../Schemas";
import { MessageType } from './Game';
import { UnitImpl } from "./UnitImpl";
import { consolex } from "../Consolex";
import { GameMap, TileRef } from "./GameMap";

export function createGame(gameMap: GameMap, miniGameMap: GameMap, nationMap: NationMap, config: Config): Game {
    return new GameImpl(gameMap, miniGameMap, nationMap, config)
}

export type CellString = string

export class GameImpl implements MutableGame {
    private _ticks = 0

    private unInitExecs: Execution[] = []


    private nations_: Nation[] = []

    _players: Map<PlayerID, PlayerImpl> = new Map<PlayerID, PlayerImpl>
    _playersBySmallID = []

    private execs: Execution[] = []
    private _width: number
    private _height: number
    _terraNullius: TerraNulliusImpl

    allianceRequests: AllianceRequestImpl[] = []
    alliances_: AllianceImpl[] = []

    private nextPlayerID = 1
    private _nextUnitID = 1

    private updates: GameUpdates = createGameUpdatesMap()

    constructor(
        public readonly M: GameMap,
        private miniGameMap: GameMap,
        nationMap: NationMap,
        private _config: Config,
    ) {
        this._terraNullius = new TerraNulliusImpl()
        this._width = M.width();
        this._height = M.height();
        this.nations_ = nationMap.nations
            .map(n => new Nation(
                n.name,
                new Cell(n.coordinates[0], n.coordinates[1]),
                n.strength
            ))
    }
    playerBySmallID(id: number): Player | TerraNullius {
        if (id == 0) {
            return this.terraNullius()
        }
        return this._playersBySmallID[id - 1]
    }
    map(): GameMap {
        return this.M
    }
    miniMap(): GameMap {
        return this.miniGameMap
    }

    addUpdate(update: GameUpdate) {
        (this.updates[update.type] as any[]).push(update);
    }


    nextUnitID(): number {
        const old = this._nextUnitID
        this._nextUnitID++
        return old
    }

    addFallout(tile: Tile) {
        const ti = tile as TileImpl
        if (tile.hasOwner()) {
            throw Error(`cannot set fallout, tile ${tile} has owner`)
        }
        this.M.setFallout(tile.ref(), true)
        this.addUpdate(ti.toUpdate())
    }

    addTileDefenseBonus(tile: Tile, unit: Unit, amount: number): DefenseBonus {
        // TODO!!
        const df = { unit: unit, tile: tile, amount: amount };
        // (tile as TileImpl)._defenseBonuses.push(df)
        // this.addUpdate((tile as TileImpl).toUpdate())
        return df
    }

    removeTileDefenseBonus(bonus: DefenseBonus): void {
        // TODO!!
        // const t = bonus.tile as TileImpl
        // t._defenseBonuses = t._defenseBonuses.filter(db => db != bonus)
        // this.addUpdate(t.toUpdate())
    }

    units(...types: UnitType[]): UnitImpl[] {
        return Array.from(this._players.values()).flatMap(p => p.units(...types))
    }
    unitInfo(type: UnitType): UnitInfo {
        return this.config().unitInfo(type)
    }
    nations(): Nation[] {
        return this.nations_
    }

    createAllianceRequest(requestor: MutablePlayer, recipient: MutablePlayer): MutableAllianceRequest {
        if (requestor.isAlliedWith(recipient)) {
            consolex.log('cannot request alliance, already allied')
            return
        }
        if (recipient.incomingAllianceRequests().find(ar => ar.requestor() == requestor) != null) {
            consolex.log(`duplicate alliance request from ${requestor.name()}`)
            return
        }
        const correspondingReq = requestor.incomingAllianceRequests().find(ar => ar.requestor() == recipient)
        if (correspondingReq != null) {
            consolex.log(`got corresponding alliance requests, accepting`)
            correspondingReq.accept()
            return
        }
        const ar = new AllianceRequestImpl(requestor, recipient, this._ticks, this)
        this.allianceRequests.push(ar)
        this.addUpdate(ar.toUpdate())
        return ar
    }

    acceptAllianceRequest(request: AllianceRequestImpl) {
        this.allianceRequests = this.allianceRequests.filter(ar => ar != request)
        const alliance = new AllianceImpl(this, request.requestor() as PlayerImpl, request.recipient() as PlayerImpl, this._ticks)
        this.alliances_.push(alliance);
        (request.requestor() as PlayerImpl).pastOutgoingAllianceRequests.push(request)
        this.addUpdate({
            type: GameUpdateType.AllianceRequestReply,
            request: request.toUpdate(),
            accepted: true,

        })
    }

    rejectAllianceRequest(request: AllianceRequestImpl) {
        this.allianceRequests = this.allianceRequests.filter(ar => ar != request);
        (request.requestor() as PlayerImpl).pastOutgoingAllianceRequests.push(request)
        this.addUpdate({
            type: GameUpdateType.AllianceRequestReply,
            request: request.toUpdate(),
            accepted: true
        })
    }

    hasPlayer(id: PlayerID): boolean {
        return this._players.has(id)
    }
    config(): Config {
        return this._config
    }

    inSpawnPhase(): boolean {
        return this._ticks <= this.config().numSpawnPhaseTurns()
    }

    ticks(): number {
        return this._ticks
    }

    executeNextTick(): GameUpdates {
        this.updates = createGameUpdatesMap()
        this.execs.forEach(e => {
            if (e.isActive() && (!this.inSpawnPhase() || e.activeDuringSpawnPhase())) {
                e.tick(this._ticks)
            }
        })
        const inited: Execution[] = []
        const unInited: Execution[] = []
        this.unInitExecs.forEach(e => {
            if (!this.inSpawnPhase() || e.activeDuringSpawnPhase()) {
                e.init(this, this._ticks)
                inited.push(e)
            } else {
                unInited.push(e)
            }
        })

        this.removeInactiveExecutions()

        this.execs.push(...inited)
        this.unInitExecs = unInited
        this._ticks++
        if (this._ticks % 100 == 0) {
            let hash = 1;
            this._players.forEach(p => {
                hash += p.hash()
            })
            consolex.log(`tick ${this._ticks}: hash ${hash}`)
        }
        for (const player of this._players.values()) {
            // Players change each to so always add them
            this.addUpdate(player.toUpdate())
        }
        return this.updates
    }

    terraNullius(): TerraNullius {
        return this._terraNullius
    }

    removeInactiveExecutions(): void {
        const activeExecs: Execution[] = []
        for (const exec of this.execs) {
            if (this.inSpawnPhase()) {
                if (exec.activeDuringSpawnPhase()) {
                    if (exec.isActive()) {
                        activeExecs.push(exec)
                    }
                } else {
                    activeExecs.push(exec)
                }
            } else {
                if (exec.isActive()) {
                    activeExecs.push(exec)
                }
            }
        }
        this.execs = activeExecs
    }

    players(): MutablePlayer[] {
        return Array.from(this._players.values()).filter(p => p.isAlive())
    }

    allPlayers(): MutablePlayer[] {
        return Array.from(this._players.values())
    }

    executions(): Execution[] {
        return [...this.execs, ...this.unInitExecs]
    }

    addExecution(...exec: Execution[]) {
        this.unInitExecs.push(...exec)
    }

    removeExecution(exec: Execution) {
        this.execs = this.execs.filter(execution => execution !== exec)
        this.unInitExecs = this.unInitExecs.filter(execution => execution !== exec)
    }

    width(): number {
        return this._width
    }

    height(): number {
        return this._height
    }

    forEachTile(fn: (tile: Tile) => void): void {
        for (let x = 0; x < this._width; x++) {
            for (let y = 0; y < this._height; y++) {
                fn(this.tile(new Cell(x, y)))
            }
        }
    }

    playerView(id: PlayerID): MutablePlayer {
        return this.player(id)
    }

    addPlayer(playerInfo: PlayerInfo, manpower: number): MutablePlayer {
        let player = new PlayerImpl(this, this.nextPlayerID, playerInfo, manpower)
        this._playersBySmallID.push(player)
        this.nextPlayerID++
        this._players.set(playerInfo.id, player)
        return player
    }

    player(id: PlayerID | null): MutablePlayer {
        if (!this._players.has(id)) {
            throw new Error(`Player with id ${id} not found`)
        }
        return this._players.get(id)
    }

    playerByClientID(id: ClientID): MutablePlayer | null {
        for (const [pID, player] of this._players) {
            if (player.clientID() == id) {
                return player
            }
        }
        return null
    }


    tile(cell: Cell): MutableTile {
        this.assertIsOnMap(cell)
        return new TileImpl(this, this.M.ref(cell.x, cell.y))
    }

    isOnMap(cell: Cell): boolean {
        return cell.x >= 0
            && cell.x < this._width
            && cell.y >= 0
            && cell.y < this._height
    }

    fromRef(ref: TileRef): Tile {
        return new TileImpl(this, ref)
    }

    neighbors(tile: Tile): Tile[] {
        return this.M.neighbors(tile.ref()).map(tr => new TileImpl(this, tr))
    }

    neighborsWithDiag(tile: Tile): Tile[] {
        const x = tile.cell().x
        const y = tile.cell().y
        const ns: Tile[] = []
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue // Skip the center tile
                const newX = x + dx
                const newY = y + dy
                if (newX >= 0 && newX < this._width && newY >= 0 && newY < this._height) {
                    ns.push(this.fromRef(this.M.ref(newX, newY)))
                }
            }
        }
        return ns
    }

    private assertIsOnMap(cell: Cell) {
        if (!this.isOnMap(cell)) {
            throw new Error(`cell ${cell.toString()} is not on map`)
        }
    }

    conquer(owner: PlayerImpl, tile: Tile): void {
        if (!tile.terrain().isLand()) {
            throw Error(`cannot conquer water`)
        }
        const tileImpl = tile as TileImpl
        let previousOwner = tileImpl.owner() as TerraNullius | PlayerImpl
        if (previousOwner.isPlayer()) {
            previousOwner._lastTileChange = this._ticks
            previousOwner._tiles.delete(tile.cell().toString())
            previousOwner._borderTiles.delete(tileImpl.ref())
            this.M.setBorder(tileImpl.ref(), false)
        }
        this.M.setOwnerID(tileImpl.ref(), owner.smallID())
        owner._tiles.set(tile.cell().toString(), tile)
        owner._lastTileChange = this._ticks
        this.updateBorders(tile)
        this.M.setFallout(tileImpl.ref(), false)
        this.addUpdate((tile as TileImpl).toUpdate())
    }

    relinquish(tile: Tile) {
        if (!tile.hasOwner()) {
            throw new Error(`Cannot relinquish tile because it is unowned: cell ${tile.cell().toString()}`)
        }
        if (tile.terrain().isWater()) {
            throw new Error("Cannot relinquish water")
        }

        const tileImpl = tile as TileImpl
        let previousOwner = tileImpl.owner() as PlayerImpl
        previousOwner._lastTileChange = this._ticks
        previousOwner._tiles.delete(tile.cell().toString())
        previousOwner._borderTiles.delete(tileImpl.ref())
        this.M.setBorder(tileImpl.ref(), false)

        this.M.setOwnerID(tileImpl.ref(), 0)
        this.updateBorders(tile)
        this.addUpdate(
            (tile as TileImpl).toUpdate()
        )
    }

    private updateBorders(tile: Tile) {
        const tiles: TileImpl[] = []
        tiles.push(tile as TileImpl)
        tile.neighbors().forEach(t => tiles.push(t as TileImpl))

        for (const t of tiles) {
            if (!t.hasOwner()) {
                this.M.setBorder(t.ref(), false)
                continue
            }
            if (this.isBorder(t)) {
                (t.owner() as PlayerImpl)._borderTiles.add(t.ref());
                this.M.setBorder(t.ref(), true)
            } else {
                (t.owner() as PlayerImpl)._borderTiles.delete(t.ref());
                this.M.setBorder(t.ref(), false)
            }
            // this.updates.push(t.toUpdate())
        }
    }

    isBorder(tile: Tile): boolean {
        if (!tile.hasOwner()) {
            return false
        }
        for (const neighbor of (tile as MutableTile).neighbors()) {
            let bordersEnemy = tile.owner() != neighbor.owner()
            if (bordersEnemy) {
                return true
            }
        }
        return false
    }

    public fireUnitUpdateEvent(unit: Unit) {
        this.addUpdate((unit as UnitImpl).toUpdate())
    }

    target(targeter: Player, target: Player) {
        this.addUpdate({
            type: GameUpdateType.TargetPlayer,
            playerID: targeter.smallID(),
            targetID: target.smallID(),
        })
    }

    public breakAlliance(breaker: Player, alliance: Alliance) {
        let other: Player = null
        if (alliance.requestor() == breaker) {
            other = alliance.recipient()
        } else {
            other = alliance.requestor()
        }
        if (!breaker.isAlliedWith(other)) {
            throw new Error(`${breaker} not allied with ${other}, cannot break alliance`)
        }
        if (!other.isTraitor()) {
            (breaker as PlayerImpl).isTraitor_ = true
        }

        const breakerSet = new Set(breaker.alliances())
        const alliances = other.alliances().filter(a => breakerSet.has(a))
        if (alliances.length != 1) {
            throw new Error(`must have exactly one alliance, have ${alliances.length}`)
        }
        this.alliances_ = this.alliances_.filter(a => a != alliances[0])
        this.addUpdate({
            type: GameUpdateType.BrokeAlliance,
            traitorID: breaker.smallID(),
            betrayedID: other.smallID()

        })
    }

    public expireAlliance(alliance: Alliance) {
        const p1Set = new Set(alliance.recipient().alliances())
        const alliances = alliance.requestor().alliances().filter(a => p1Set.has(a))
        if (alliances.length != 1) {
            throw new Error(`cannot expire alliance: must have exactly one alliance, have ${alliances.length}`)
        }
        this.alliances_ = this.alliances_.filter(a => a != alliances[0])
        this.addUpdate({
            type: GameUpdateType.AllianceExpired,
            player1ID: alliance.requestor().smallID(),
            player2ID: alliance.recipient().smallID()
        })
    }

    sendEmojiUpdate(sender: Player, recipient: Player | typeof AllPlayers, emoji: string): void {
        const recipientID = recipient === AllPlayers ? recipient : recipient.smallID();

        this.addUpdate({
            type: GameUpdateType.EmojiUpdate,
            message: emoji,
            senderID: sender.smallID(),
            recipientID: recipientID,
            createdAt: this._ticks
        })
    }

    setWinner(winner: Player): void {
        this.addUpdate({
            type: GameUpdateType.WinUpdate,
            winnerID: winner.smallID()
        })
    }

    displayMessage(message: string, type: MessageType, playerID: PlayerID | null): void {
        let id = null
        if (playerID != null) {
            id = this.player(playerID).smallID()
        }
        this.addUpdate({
            type: GameUpdateType.DisplayEvent,
            messageType: type,
            message: message,
            playerID: id
        })
    }
}

// Or a more dynamic approach that will catch new enum values:
const createGameUpdatesMap = (): GameUpdates => {
    const map = {} as GameUpdates;
    Object.values(GameUpdateType)
        .filter(key => !isNaN(Number(key)))  // Filter out reverse mappings
        .forEach(key => {
            map[key as GameUpdateType] = [];
        });
    return map;
};
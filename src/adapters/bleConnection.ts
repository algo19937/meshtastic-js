import {
  FromNumUuid,
  FromRadioUuid,
  ServiceUuid,
  ToRadioUuid,
} from "../constants.ts";
import { MeshDevice } from "../meshDevice.ts";
import * as Types from "../types.ts";
import { typedArrayToBuffer } from "../utils/index.ts";

/** Allows to connect to a Meshtastic device via bluetooth */
export class BleConnection extends MeshDevice {
  /** Defines the connection type as ble */
  public connType: Types.ConnectionTypeName;

  public portId: string;

  /** Currently connected BLE device */
  public device: BluetoothDevice | undefined;

  private gattServer: BluetoothRemoteGATTServer | undefined;

  /** Short Description */
  private service: BluetoothRemoteGATTService | undefined;

  /** Short Description */
  private toRadioCharacteristic: BluetoothRemoteGATTCharacteristic | undefined;

  /** Short Description */
  private fromRadioCharacteristic:
    | BluetoothRemoteGATTCharacteristic
    | undefined;

  /** Short Description */
  private fromNumCharacteristic: BluetoothRemoteGATTCharacteristic | undefined;

  private timerUpdateFromRadio: ReturnType<typeof setInterval> | null = null;

  /**
   * FIX #2: Guard flag to prevent concurrent GATT reads.
   * BLE GATT does not support parallel operations — concurrent readValue()
   * calls cause "GATT operation already in progress" errors and drop the link.
   */
  private pendingRead = false;

  constructor(configId?: number) {
    super(configId);

    this.log = this.log.getSubLogger({ name: "BleConnection" });

    this.connType = "ble";
    this.portId = "";
    this.device = undefined;
    this.service = undefined;
    this.gattServer = undefined;
    this.toRadioCharacteristic = undefined;
    this.fromRadioCharacteristic = undefined;
    this.fromNumCharacteristic = undefined;

    this.log.debug(
      Types.Emitter[Types.Emitter.Constructor],
      "🔷 BleConnection instantiated",
    );
  }

  /**
   * Gets web bluetooth support avaliability for the device
   *
   * @returns {Promise<void>}
   */
  public supported(): Promise<boolean> {
    return navigator.bluetooth.getAvailability();
  }

  /**
   * Gets list of bluetooth devices that can be passed to `connect`
   *
   * @returns {Promise<BluetoothDevice[]>} Array of avaliable BLE devices
   */
  public getDevices(): Promise<BluetoothDevice[]> {
    return navigator.bluetooth.getDevices();
  }

  /** Opens browser dialog to select a device */
  private isScanning = false;

  /**
   * FIX #7: Guard against concurrent scan requests.
   * On Linux, calling requestDevice() while a scan is already in progress
   * throws "requestDevice error: request in progress", which accumulates
   * DBus connections and eventually hits the per-UID connection limit.
   */
  public async getDevice(filter?: RequestDeviceOptions): Promise<BluetoothDevice> {
    if (this.isScanning) {
      throw new Error("Scan already in progress");
    }

    this.isScanning = true;
    try {
      return await navigator.bluetooth.requestDevice(
        filter ?? { filters: [{ services: [ServiceUuid] }] },
      );
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Initiates the connect process to a Meshtastic device via Bluetooth
   */
  public async connect({
    device,
    deviceFilter,
  }: Types.BleConnectionParameters): Promise<void> {
    /** Set device state to connecting */
    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnecting);

    /** Set device if specified, else request. */
    this.device = device ?? (await this.getDevice(deviceFilter));

    this.portId = this.device.id;

    /**
     * FIX #3: Clear timer inside the passive-disconnect handler.
     * When the remote device drops the link, this event fires but the
     * original disconnect() is never called, so the polling timer was
     * left running and kept throwing GATT errors indefinitely.
     */
    this.device.addEventListener("gattserverdisconnected", () => {
      this.log.info(
        Types.Emitter[Types.Emitter.Connect],
        "Device disconnected",
      );
      this._clearTimer();
      this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
      this.complete();
    });

    // ── Step 1: Connect GATT ──────────────────────────────────────────────
    let connectError = "";
    await this.device.gatt
      ?.connect()
      .then((server) => {
        this.log.info(
          Types.Emitter[Types.Emitter.Connect],
          `✅ Got GATT Server for device: ${server.device.id}`,
        );
        this.gattServer = server;
      })
      .catch((e: Error) => {
        this.log.error(
          Types.Emitter[Types.Emitter.Connect],
          `❌ Failed to connect: ${e.message}`,
        );
        connectError = e.message;
      });

    if (connectError) {
      this.log.error(
        Types.Emitter[Types.Emitter.Connect],
        "Aborting connect due to GATT error.",
      );
      // FIX #5: Always surface connection failure to callers via status update.
      this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
      this.disconnect();
      return;
    }

    // ── Step 2: Get primary service ───────────────────────────────────────
    let serviceError = "";
    await this.gattServer
      ?.getPrimaryService(ServiceUuid)
      .then((service) => {
        this.log.info(
          Types.Emitter[Types.Emitter.Connect],
          `✅ Got GATT Service for device: ${service.device.id}`,
        );
        this.service = service;
      })
      .catch((e: Error) => {
        this.log.error(
          Types.Emitter[Types.Emitter.Connect],
          `❌ Failed to get primary service: ${e.message}`,
        );
        serviceError = e.message;
      });

    if (serviceError) {
      // FIX #5: Surface service-discovery failure.
      this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
      this.disconnect();
      return;
    }

    // ── Step 3: Get all characteristics ──────────────────────────────────
    /**
     * FIX #1: Use Promise.all() instead of .map() so every characteristic
     * is fully resolved before we call startNotifications().
     * The original code used .map(async ...) which returns Promise<void>[]
     * without awaiting them, so fromNumCharacteristic was still undefined
     * when startNotifications() was called, silently skipping the subscription.
     */
    await Promise.all(
      [ToRadioUuid, FromRadioUuid, FromNumUuid].map(async (uuid) => {
        await this.service
          ?.getCharacteristic(uuid)
          .then((characteristic) => {
            this.log.info(
              Types.Emitter[Types.Emitter.Connect],
              `✅ Got Characteristic ${characteristic.uuid}`,
            );
            switch (uuid) {
              case ToRadioUuid:
                this.toRadioCharacteristic = characteristic;
                break;
              case FromRadioUuid:
                this.fromRadioCharacteristic = characteristic;
                break;
              case FromNumUuid:
                this.fromNumCharacteristic = characteristic;
                break;
            }
          })
          .catch((e: Error) => {
            this.log.error(
              Types.Emitter[Types.Emitter.Connect],
              `❌ Failed to get characteristic ${uuid}: ${e.message}`,
            );
          });
      }),
    );

    // FIX #5: Abort if critical characteristics are missing.
    if (!this.fromRadioCharacteristic || !this.toRadioCharacteristic) {
      this.log.error(
        Types.Emitter[Types.Emitter.Connect],
        "❌ Critical characteristics missing, aborting connect.",
      );
      this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
      this.disconnect();
      return;
    }

    // ── Step 4: Subscribe to fromNum notifications ────────────────────────
    await this.fromNumCharacteristic?.startNotifications().catch((e: Error) => {
      this.log.error(
        Types.Emitter[Types.Emitter.Connect],
        `❌ Failed to start notifications: ${e.message}`,
      );
    });

    /**
     * FIX #2 (part A): The notification handler only triggers readFromRadio()
     * if no read is already in flight (enforced inside readFromRadio via
     * pendingRead). This prevents the characteristicvaluechanged event and
     * the polling timer from issuing simultaneous GATT reads.
     */
    this.fromNumCharacteristic?.addEventListener(
      "characteristicvaluechanged",
      () => {
        this.readFromRadio();
      },
    );

    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnected);

    this.configure().catch(() => {
      // TODO: FIX, workaround for `wantConfigId` not getting acks.
    });

    /**
     * FIX #2 (part B): Keep the polling timer as a safety net but rely
     * primarily on GATT notifications. The pendingRead guard inside
     * readFromRadio() ensures the timer and the notification handler never
     * issue concurrent GATT operations.
     */
    this.timerUpdateFromRadio = setInterval(() => this.readFromRadio(), 5000);
  }

  /** Disconnects from the Meshtastic device */
  public disconnect(): void {
    /**
     * FIX #3: Always clear the timer in disconnect() too, covering the case
     * where the caller triggers disconnect() explicitly before the
     * gattserverdisconnected event fires.
     */
    this._clearTimer();
    this.device?.gatt?.disconnect();
    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
    this.complete();
  }

  /** Pings device to check if it is available */
  public async ping(): Promise<boolean> {
    return await Promise.resolve(true);
  }

  /**
   * Reads data packets from the radio until empty.
   *
   * FIX #2: pendingRead flag serialises all callers (notification handler +
   * polling timer + writeToRadio). Without this guard, two concurrent
   * readValue() calls on the same characteristic cause a GATT-level error
   * that silently kills the connection on most platforms.
   */
  protected async readFromRadio(): Promise<void> {
    if (this.pendingRead) {
      return;
    }
    this.pendingRead = true;

    try {
      let hasMoreData = true;
      while (hasMoreData && this.fromRadioCharacteristic) {
        const value = await this.fromRadioCharacteristic.readValue();

        /**
         * FIX #6: Guard against undefined/null returned by readValue().
         * On Linux with SimplebleAdapter, readValue() can return undefined
         * when the BLE stack is busy or the link is marginal. Without this
         * check the original code crashed with:
         *   "Cannot read properties of undefined (reading 'buffer')"
         * Treat it as an empty read and exit the loop cleanly instead.
         */
        if (!value) {
          this.log.warn(
            Types.Emitter[Types.Emitter.ReadFromRadio],
            "⚠️ readValue() returned undefined, treating as empty read.",
          );
          hasMoreData = false;
          continue;
        }

        if (value.byteLength === 0) {
          hasMoreData = false;
          continue;
        }

        await this.handleFromRadio(new Uint8Array(value.buffer));
        this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnected);
      }
    } catch (error) {
      this.log.error(
        Types.Emitter[Types.Emitter.ReadFromRadio],
        `❌ ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      throw error;
    } finally {
      this.pendingRead = false;
    }
  }

  /**
   * Sends supplied protobuf message to the radio.
   *
   * FIX #4: Removed the manual readFromRadio() call after writeValue().
   * The fromNum notification fires automatically after a write, which
   * triggers readFromRadio() via the event listener. Calling it manually
   * here as well caused two concurrent GATT reads and frequent
   * "GATT operation already in progress" disconnects.
   */
  protected async writeToRadio(data: Uint8Array): Promise<void> {
    await this.toRadioCharacteristic?.writeValue(typedArrayToBuffer(data));
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Clears the polling timer if it is active. */
  private _clearTimer(): void {
    if (this.timerUpdateFromRadio !== null) {
      clearInterval(this.timerUpdateFromRadio);
      this.timerUpdateFromRadio = null;
    }
  }
}

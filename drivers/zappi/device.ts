import { Device } from 'homey';
import { MyEnergi, Zappi, ZappiBoostMode, ZappiChargeMode, ZappiStatus } from 'myenergi-api';
import { MyEnergiApp } from '../../app';
import { ZappiDriver } from './driver';
import { ZappiBoostModeText } from './ZappiBoostModeText';
import { ZappiChargeModeText } from './ZappiChargeModeText';
import { ZappiData } from "./ZappiData";
import { ZappiStatusText } from './ZappiStatusText';

export class ZappiDevice extends Device {

  private _app!: MyEnergiApp;
  private _driver!: ZappiDriver;

  private _callbackId: number = -1;
  private _chargeMode: ZappiChargeMode = ZappiChargeMode.Fast;
  private _lastOnState: ZappiChargeMode = ZappiChargeMode.Fast;
  private _lastChargingStarted: boolean = false;
  private _lastChargeMode: ZappiChargeMode = ZappiChargeMode.Fast;
  private _lastBoostMode: ZappiBoostMode = ZappiBoostMode.Stop;
  private _chargerStatus: ZappiStatus = ZappiStatus.EvDisconnected;
  private _boostMode: ZappiBoostMode = ZappiBoostMode.Stop;
  private _lastBoostState: ZappiBoostMode = ZappiBoostMode.Stop;
  private _chargingPower: number = 0;
  private _chargingVoltage: number = 0;
  private _chargingCurrent: number = 0;
  private _chargeAdded: number = 0;
  private _frequency: number = 0;
  private _minimumGreenLevel: number = 0;
  private _settings: any;
  private _powerCalculationModeSetToAuto!: boolean;

  private _lastEnergyCalculation: Date = new Date();
  private _lastPowerMeasurement: number = 0;

  public deviceId!: string;
  public myenergiClientId!: string;
  public myenergiClient!: MyEnergi;

  /**
   * onInit is called when the device is initialized.
   */
  public async onInit(): Promise<void> {
    const dev = this as ZappiDevice;

    dev._app = dev.homey.app as MyEnergiApp;
    dev._driver = dev.driver as ZappiDriver;

    // Make sure capabilities are up to date.
    if (dev.detectCapabilityChanges()) {
      await dev.InitializeCapabilities();
    }

    dev._settings = dev.getSettings();
    dev._callbackId = dev._driver.registerDataUpdateCallback((data: any) => dev.dataUpdated(data)) - 1;
    dev.deviceId = dev.getData().id;
    dev.myenergiClientId = dev.getStoreValue('myenergiClientId');

    try {
      // Collect data.
      dev.myenergiClient = dev._app.clients[dev.myenergiClientId];
      const zappi: Zappi | null = await dev.myenergiClient.getStatusZappi(dev.deviceId);
      if (zappi) {
        dev.calculateValues(zappi); // P=U*I -> I=P/U
        if (dev._chargeMode !== ZappiChargeMode.Off) {
          dev._lastOnState = dev._chargeMode;
          dev._lastChargingStarted = true;
        }
      }
    } catch (error) {
      dev.error(error);
    }

    // Set capabilities
    dev.setCapabilityValues();
    dev.log(`Status: ${dev._chargerStatus}`);

    dev.registerCapabilityListener('onoff', dev.onCapabilityOnoff.bind(this));
    dev.registerCapabilityListener('charge_mode_selector', dev.onCapabilityChargeMode.bind(this));
    dev.registerCapabilityListener('set_minimum_green_level', dev.onCapabilityGreenLevel.bind(this));
    dev.registerCapabilityListener('button.reset_meter', async () => {
      dev.setCapabilityValue('meter_power', 0);
    });

    // Flow logic
    const chargingCondition = dev.homey.flow.getConditionCard('is_charging');
    chargingCondition.registerRunListener(async (args, state) => {
      dev.log(`Is Charging: ${args} - ${state}`);
      const charging = dev._chargerStatus === ZappiStatus.Charging; // true or false
      return charging;
    });

    const startChargingAction = dev.homey.flow.getActionCard('start_charging');
    startChargingAction.registerRunListener(async (args, state) => {
      dev.log(`Start Charging: ${args} - ${state}`);
      await dev.setChargerState(true);
    });

    const stopChargingAction = dev.homey.flow.getActionCard('stop_charging');
    stopChargingAction.registerRunListener(async (args, state) => {
      dev.log(`Stop Charging: ${args} - ${state}`);
      await dev.setChargerState(false);
    });

    const setChargeModeAction = dev.homey.flow.getActionCard('set_charge_mode');
    setChargeModeAction.registerRunListener(async (args, state) => {
      dev.log(`Charge Mode: ${args.charge_mode_txt}`);
      dev._chargeMode = dev.getChargeMode(args.charge_mode_txt);
      if (dev._chargeMode !== ZappiChargeMode.Off) {
        dev._lastOnState = dev._chargeMode;
      }
      await dev.setChargeMode(dev._chargeMode);
    });

    const selectChargeModeAction = dev.homey.flow.getActionCard('select_charge_mode');
    selectChargeModeAction.registerRunListener(async (args, state) => {
      dev.log(`Charge Mode: ${args.charge_mode_selector}`);
      dev._chargeMode = dev.getChargeMode(args.charge_mode_selector);
      if (dev._chargeMode !== ZappiChargeMode.Off) {
        dev._lastOnState = dev._chargeMode;
      }
      await dev.setChargeMode(dev._chargeMode);
    });

    const setBoostModeAction = dev.homey.flow.getActionCard('set_boost_mode');
    setBoostModeAction.registerRunListener(async (args, state) => {
      dev.log(`Boost Mode: ${args.boost_mode_txt}, Boost Mode: ${args.boost_mode_kwh}, Boost Mode: ${args.boost_mode_complete_time}`);
      const kwh = args.boost_mode_kwh as number;
      const completeTime = args.boost_mode_complete_time as number;
      dev._boostMode = dev.getBoostMode(args.boost_mode_txt);
      dev._lastBoostState = dev._boostMode;
      await dev.setBoostMode(dev._boostMode, kwh, completeTime);
    });

    dev.log(`ZappiDevice ${dev.deviceId} has been initialized`);
  }

  private isChargeModeValueText(value: ZappiChargeMode | ZappiChargeModeText): boolean {
    switch (value) {
      case ZappiChargeMode.Eco:
      case ZappiChargeMode.EcoPlus:
      case ZappiChargeMode.Fast:
      case ZappiChargeMode.Off:
        return false

      case ZappiChargeModeText.Eco:
      case ZappiChargeModeText.EcoPlus:
      case ZappiChargeModeText.Fast:
      case ZappiChargeModeText.Off:
        return true

      default:
        return false;
    }
  }

  private isZappiStatusValueText(value: ZappiStatus | ZappiStatusText): boolean {
    switch (value) {
      case ZappiStatus.Charging:
      case ZappiStatus.EvConnected:
      case ZappiStatus.EvDisconnected:
      case ZappiStatus.EvReadyToCharge:
      case ZappiStatus.Fault:
      case ZappiStatus.WaitingForEv:
        return false

      case ZappiStatusText.Charging:
      case ZappiStatusText.EvConnected:
      case ZappiStatusText.EvDisconnected:
      case ZappiStatusText.EvReadyToCharge:
      case ZappiStatusText.Fault:
      case ZappiStatusText.WaitingForEv:
        return true

      default:
        return false;
    }
  }

  /**
   * Validate capabilities. Add new and delete removed capabilities.
   */
  private async InitializeCapabilities(): Promise<void> {
    const dev: ZappiDevice = this;
    dev.log(`****** Initializing Zappi sensor capabilities ******`);
    const caps = dev.getCapabilities();
    const tmpCaps: any = {};
    // Remove all capabilities in case the order has changed
    for (const cap of caps) {
      try {
        if (['onoff', 'charge_mode_selector', 'button.reset_meter'].includes(cap))
          continue;
        tmpCaps[cap] = this.getCapabilityValue(cap);
        await dev.removeCapability(cap).catch(dev.error);
        dev.log(`*** ${cap} - Removed`);
      } catch (error) {
        dev.error(error);
      }
    }
    // Re-apply all capabilities.
    for (const cap of dev._driver.capabilities) {
      try {
        if (['onoff', 'charge_mode_selector', 'button.reset_meter'].includes(cap))
          continue;
        await dev.addCapability(cap).catch(dev.error);
        if (tmpCaps[cap])
          this.setCapabilityValue(cap, tmpCaps[cap]);
        dev.log(`*** ${cap} - Added`);
      } catch (error) {
        dev.error(error);
      }
    }
    dev.log(`****** Sensor capability initialization complete ******`);
  }

  /**
   * Validate capabilities. Add new and delete removed capabilities.
   */
  private detectCapabilityChanges(): boolean {
    const dev: ZappiDevice = this;
    let result = false;
    dev.log(`Detecting Zappi capability changes...`);
    const caps = dev.getCapabilities();
    for (const cap of caps) {
      if (!dev._driver.capabilities.includes(cap)) {
        dev.log(`Zappi capability ${cap} was removed.`);
        result = true;
      }
    }
    for (const cap of dev._driver.capabilities) {
      if (!dev.hasCapability(cap)) {
        dev.log(`Zappi capability ${cap} was added.`);
        result = true;
      }
    }
    if (!result)
      dev.log('No changes in capabilities.');
    return result;
  }

  private getRndInteger(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Set capability values from collected values.
   */
  private setCapabilityValues(): void {
    const dev: ZappiDevice = this;
    dev.setCapabilityValue('onoff', dev._chargeMode !== ZappiChargeMode.Off).catch(dev.error);
    dev.setCapabilityValue('charge_mode', `${dev._chargeMode}`).catch(dev.error);
    dev.setCapabilityValue('charge_mode_txt', `${dev.getChargeModeText(dev._chargeMode)}`).catch(dev.error);
    dev.setCapabilityValue('charge_mode_selector', `${dev._chargeMode}`).catch(dev.error);
    dev.setCapabilityValue('charger_status', `${dev._chargerStatus}`).catch(dev.error);
    dev.setCapabilityValue('charger_status_txt', `${dev.getChargerStatusText(dev._chargerStatus)}`).catch(dev.error);
    dev.setCapabilityValue('measure_power', dev._chargingPower ? dev._chargingPower : 0).catch(dev.error);
    dev.setCapabilityValue('measure_voltage', dev._chargingVoltage ? dev._chargingVoltage : 0).catch(dev.error);
    dev.setCapabilityValue('measure_current', dev._chargingCurrent ? dev._chargingCurrent : 0).catch(dev.error);
    dev.setCapabilityValue('charge_session_consumption', dev._chargeAdded ? dev._chargeAdded : 0).catch(dev.error);
    dev.setCapabilityValue('measure_frequency', dev._frequency ? dev._frequency : 0).catch(dev.error);
    dev.setCapabilityValue('meter_power', dev.calculateEnergy()).catch(dev.error);
    dev.setCapabilityValue('minimum_green_level', dev._minimumGreenLevel).catch(dev.error);
    dev.setCapabilityValue('set_minimum_green_level', dev._minimumGreenLevel).catch(dev.error);
  }

  /**
   * Calculate accumulated kWh since last power measurement
   * @returns Accumulated kWh 
   */
  private calculateEnergy(): number {
    const dev: ZappiDevice = this;
    const dateNow = new Date();
    var seconds = Math.abs((dateNow.getTime() - this._lastEnergyCalculation.getTime()) / 1000);
    let prevEnergy: number = dev.getCapabilityValue('meter_power');
    let newEnergy: number = prevEnergy + ((((this._lastPowerMeasurement + dev._chargingPower) / 2) * seconds) / 3600000);
    dev.log(`Energy algo: ${prevEnergy} + ((((${this._lastPowerMeasurement} + ${dev._chargingPower}) / 2) * ${seconds}) / 3600000)`);
    this._lastPowerMeasurement = dev._chargingPower;
    this._lastEnergyCalculation = dateNow;
    return newEnergy;
  }

  /**
   * Assign and calculate values from Zappi.
   */
  private async calculateValues(zappi: Zappi): Promise<void> {
    const dev: ZappiDevice = this;
    dev._chargeMode = zappi.zmo;
    dev._chargerStatus = zappi.pst as ZappiStatus;
    dev._chargingPower = 0;
    if ((dev._settings.powerCalculationMode === 'automatic' && zappi.ectt1 === 'Internal Load')
      || (dev._settings.powerCalculationMode === 'manual' && dev._settings.includeCT1)) {
      dev._chargingPower += zappi.ectp1 ? zappi.ectp1 : 0;
    }
    if ((dev._settings.powerCalculationMode === 'automatic' && zappi.ectt2 === 'Internal Load')
      || (dev._settings.powerCalculationMode === 'manual' && dev._settings.includeCT2)) {
      dev._chargingPower += zappi.ectp2 ? zappi.ectp2 : 0;
    }
    if ((dev._settings.powerCalculationMode === 'automatic' && zappi.ectt3 === 'Internal Load')
      || (dev._settings.powerCalculationMode === 'manual' && dev._settings.includeCT3)) {
      dev._chargingPower += zappi.ectp3 ? zappi.ectp3 : 0;
    }
    if ((dev._settings.powerCalculationMode === 'automatic' && zappi.ectt4 === 'Internal Load')
      || (dev._settings.powerCalculationMode === 'manual' && dev._settings.includeCT4)) {
      dev._chargingPower += zappi.ectp4 ? zappi.ectp4 : 0;
    }
    if ((dev._settings.powerCalculationMode === 'automatic' && zappi.ectt5 === 'Internal Load')
      || (dev._settings.powerCalculationMode === 'manual' && dev._settings.includeCT5)) {
      dev._chargingPower += zappi.ectp5 ? zappi.ectp5 : 0;
    }
    if ((dev._settings.powerCalculationMode === 'automatic' && zappi.ectt6 === 'Internal Load')
      || (dev._settings.powerCalculationMode === 'manual' && dev._settings.includeCT6)) {
      dev._chargingPower += zappi.ectp6 ? zappi.ectp6 : 0;
    }

    if (dev._settings.showNegativeValues === false) {
      dev._chargingPower = dev._chargingPower > 0 ? dev._chargingPower : 0;
    }

    dev._chargingVoltage = zappi.vol ? (zappi.vol / 10) : 0;
    dev._chargeAdded = zappi.che ? zappi.che : 0;
    dev._frequency = zappi.frq ? zappi.frq : 0;
    dev._minimumGreenLevel = zappi.mgl ? zappi.mgl : 0;
    dev._chargingCurrent = (dev._chargingVoltage > 0) ? (dev._chargingPower / dev._chargingVoltage) : 0; // P=U*I -> I=P/U

    if (dev._powerCalculationModeSetToAuto) {
      dev._powerCalculationModeSetToAuto = false;
      const tmpSettings: any =
      {
        includeCT1: zappi.ectt1 === 'Internal Load',
        includeCT2: zappi.ectt2 === 'Internal Load',
        includeCT3: zappi.ectt3 === 'Internal Load',
        includeCT4: zappi.ectt4 === 'Internal Load',
        includeCT5: zappi.ectt5 === 'Internal Load',
        includeCT6: zappi.ectt6 === 'Internal Load',
      };

      dev.setSettings(tmpSettings);
    }
  }

  /**
   * Trigger charging flows.
   * @param chargingStarted true if charging has started
   * @returns void
   */
  private async triggerChargingFlow(chargingStarted: boolean): Promise<void> {
    const dev: ZappiDevice = this;
    const tokens = {}; //TODO Add tokens
    const state = {};
    if (chargingStarted === dev._lastChargingStarted) {
      return;
    }
    dev._lastChargingStarted = chargingStarted;

    dev.driver.ready().then(() => {
      if (chargingStarted) {
        (dev.driver as ZappiDriver).triggerChargingStartedFlow(dev, tokens, state);
      } else {
        (dev.driver as ZappiDriver).triggerChargingStoppedFlow(dev, tokens, state);
      }
    });
  }

  /**
   * Trigger charging flows.
   * @param chargingStarted true if charging has started
   * @returns void
   */
  private async triggerChargeModeFlow(chargeMode: ZappiChargeMode): Promise<void> {
    const dev: ZappiDevice = this;
    const tokens = {}; //TODO Add tokens
    const state = {};
    if (chargeMode === dev._lastChargeMode) {
      return;
    }
    const isTurnedOn = dev._lastChargeMode === ZappiChargeMode.Off;
    dev._lastChargeMode = chargeMode;

    dev.driver.ready().then(() => {
      (dev.driver as ZappiDriver).triggerChargeModeFlow(dev, tokens, state);
      if (chargeMode === ZappiChargeMode.Off) {
        (dev.driver as ZappiDriver).triggerChargingStoppedFlow(dev, tokens, state);
      } else if (isTurnedOn) {
        (dev.driver as ZappiDriver).triggerChargingStartedFlow(dev, tokens, state);
      }
    });
  }

  /**
   * Trigger charging flows.
   * @param chargingStarted true if charging has started
   * @returns void
   */
  private async triggerBoostModeFlow(boostMode: ZappiBoostMode): Promise<void> {
    const dev: ZappiDevice = this;
    const tokens = {}; //TODO Add tokens
    const state = {};
    if (boostMode === dev._lastBoostMode) {
      return;
    }
    const isTurnedOn = dev._lastChargeMode === ZappiChargeMode.Off;
    dev._lastBoostMode = boostMode;

    dev.driver.ready().then(() => {
      (dev.driver as ZappiDriver).triggerBoostModeFlow(dev, tokens, state);
    });
  }

  /**
   * Event handler for data updates.
   * @param data Zappi data
   */
  private async dataUpdated(data: ZappiData[]): Promise<void> {
    const dev: ZappiDevice = this;
    dev.log('Received data from driver.');
    if (data) {
      data.forEach((zappi: ZappiData) => {
        if (zappi && zappi.sno === dev.deviceId) {
          try {
            if (zappi.zmo !== ZappiChargeMode.Off) {
              dev._lastOnState = zappi.zmo;
            }
            dev.calculateValues(zappi);
            dev.setCapabilityValues();
          } catch (error) {
            dev.error(error);
          }
        }
      });
    }
  }

  /**
   * Turn Zappi on or off. On is last charge mode.
   * @param isOn true if charger is on
   */
  private async setChargerState(isOn: boolean): Promise<void> {
    const dev: ZappiDevice = this;
    try {
      const result = await dev.myenergiClient.setZappiChargeMode(dev.deviceId, isOn ? dev._lastOnState : ZappiChargeMode.Off);
      if (result.status !== 0) {
        throw new Error(result);
      }
      dev.triggerChargingFlow(isOn);
      dev.log(`Zappi was switched ${isOn ? 'on' : 'off'}`);
    } catch (error) {
      dev.error(error);
      throw new Error(`Switching the Zappi ${isOn ? 'on' : 'off'} failed!`);
    }
  }

  /**
   * Set Zappi minimum green level.
   * @param value Percentage generated power
   */
  private async setMinimumGreenLevel(value: number): Promise<void> {
    const dev: ZappiDevice = this;
    try {
      const result = await dev.myenergiClient.setZappiGreenLevel(dev.deviceId, value);
      if (result.mgl !== value) {
        throw new Error(JSON.stringify(result));
      }
    } catch (error) {
      dev.error(error);
      throw new Error(`Switching the Zappi ${value ? 'on' : 'off'} failed!`);
    }
  }

  /**
   * Turn Zappi on or off. On is last charge mode.
   * @param isOn true if charger is on
   */
  private async setChargeMode(chargeMode: ZappiChargeMode): Promise<void> {
    const dev: ZappiDevice = this;

    try {
      dev.setCapabilityValue('onoff', chargeMode !== ZappiChargeMode.Off).catch(dev.error);
      dev.setCapabilityValue('charge_mode', `${chargeMode}`).catch(dev.error);
      dev.setCapabilityValue('charge_mode_selector', `${chargeMode}`).catch(dev.error);
      dev.setCapabilityValue('charge_mode_txt', `${dev.getChargeModeText(chargeMode)}`).catch(dev.error);

      const result = await dev.myenergiClient.setZappiChargeMode(dev.deviceId, chargeMode);
      if (result.status !== 0) {
        throw new Error(result);
      }

      dev.triggerChargeModeFlow(chargeMode);
      dev.log(`Zappi changed charge mode ${dev.getChargeModeText(chargeMode)}`);
    } catch (error) {
      dev.error(error);
      throw new Error(`Switching the Zappi charge mode ${dev.getChargeModeText(chargeMode)} failed!`);
    }
  }

  /**
   * Turn Zappi on or off. On is last charge mode.
   * @param isOn true if charger is on
   */
  private async setBoostMode(boostMode: ZappiBoostMode, kWh?: number, completeTime?: number): Promise<void> {
    const dev: ZappiDevice = this;

    try {
      dev.setCapabilityValue('zappi_boost_mode', `${dev.getBoostModeText(boostMode)}`).catch(dev.error);

      const result = await dev.myenergiClient.setZappiBoostMode(dev.deviceId, boostMode);
      if (result.status !== 0) {
        throw new Error(result);
      }

      dev.triggerBoostModeFlow(boostMode);
      dev.log(`Zappi changed boost mode ${dev.getBoostModeText(boostMode)}`);
    } catch (error) {
      dev.error(error);
      throw new Error(`Switching the Zappi charge mode ${(dev.getBoostModeText(boostMode))} failed!`);
    }
  }

  /**
   * Event handler for charge mode capability listener
   * @param value Charge mode
   * @param opts Options
   */
  private async onCapabilityChargeMode(value: any, opts: any): Promise<void> {
    const dev: ZappiDevice = this;
    dev.log(`Charge Mode: ${value}`);
    dev._chargeMode = value;
    if (dev._chargeMode !== ZappiChargeMode.Off) {
      dev._lastOnState = dev._chargeMode;
    }
    await dev.setChargerState(dev._chargeMode !== ZappiChargeMode.Off);
    dev.setCapabilityValue('onoff', dev._chargeMode !== ZappiChargeMode.Off).catch(dev.error);
    dev.setCapabilityValue('charge_mode', `${dev._chargeMode}`).catch(dev.error);
    dev.setCapabilityValue('charge_mode_txt', `${dev.getChargeModeText(dev._chargeMode)}`).catch(dev.error);
  }

  /**
   * Event handler for onoff capability listener
   * @param value On or off
   * @param opts Options
   */
  private async onCapabilityOnoff(value: boolean, opts: any): Promise<void> {
    const dev: ZappiDevice = this;
    dev.log(`onoff: ${value}`);
    await dev.setChargerState(value);
    dev.setCapabilityValue('charge_mode', value ? `${dev._chargeMode}` : `${ZappiChargeModeText.Off}`).catch(dev.error);
    dev.setCapabilityValue('charge_mode_txt', value ? `${dev.getChargeModeText(dev._chargeMode)}` : `${ZappiChargeModeText.Off}`).catch(dev.error);
    dev.setCapabilityValue('charge_mode_selector', value ? `${dev._chargeMode}` : `${ZappiChargeModeText.Off}`).catch(dev.error);
  }

  /**
   * Event handler for onoff capability listener
   * @param value On or off
   * @param opts Options
   */
  private async onCapabilityGreenLevel(value: number, opts: any): Promise<void> {
    const dev: ZappiDevice = this;
    dev.log(`Minimum Green Level: ${value}`);
    dev.setCapabilityValue('minimum_green_level', value).catch(dev.error);
    dev.setCapabilityValue('set_minimum_green_level', value).catch(dev.error);
    await dev.setMinimumGreenLevel(value);
  }

  private getChargeMode(value: ZappiChargeModeText): ZappiChargeMode {
    switch (value) {
      case ZappiChargeModeText.Fast:
        return ZappiChargeMode.Fast;
      case ZappiChargeModeText.Eco:
        return ZappiChargeMode.Eco;
      case ZappiChargeModeText.EcoPlus:
        return ZappiChargeMode.EcoPlus;
      case ZappiChargeModeText.Off:
        return ZappiChargeMode.Off;
      default:
        throw new Error(`Invalid charge mode ${value}`);
        ;
    };
  }

  private getChargeModeText(value: ZappiChargeMode): ZappiChargeModeText {
    switch (value) {
      case ZappiChargeMode.Fast:
        return ZappiChargeModeText.Fast;
      case ZappiChargeMode.Eco:
        return ZappiChargeModeText.Eco;
      case ZappiChargeMode.EcoPlus:
        return ZappiChargeModeText.EcoPlus;
      case ZappiChargeMode.Off:
        return ZappiChargeModeText.Off;
      default:
        throw new Error(`Invalid charge mode ${value}`);
    };
  }

  private getBoostMode(value: ZappiBoostModeText): ZappiBoostMode {
    switch (value) {
      case ZappiBoostModeText.Manual:
        return ZappiBoostMode.Manual;
      case ZappiBoostModeText.Smart:
        return ZappiBoostMode.Smart;
      case ZappiBoostModeText.Stop:
        return ZappiBoostMode.Stop;
      default:
        throw new Error(`Invalid boost mode ${value}`);
    };
  }

  private getBoostModeText(value: ZappiBoostMode): ZappiBoostModeText {
    switch (value) {
      case ZappiBoostMode.Manual:
        return ZappiBoostModeText.Manual;
      case ZappiBoostMode.Smart:
        return ZappiBoostModeText.Smart;
      case ZappiBoostMode.Stop:
        return ZappiBoostModeText.Stop;
      default:
        throw new Error(`Invalid boost mode ${value}`);
    };
  }

  private getChargerStatusText(value: ZappiStatus): ZappiStatusText {
    switch (value) {
      case ZappiStatus.Charging:
        return ZappiStatusText.Charging;
      case ZappiStatus.EvConnected:
        return ZappiStatusText.EvConnected;
      case ZappiStatus.EvDisconnected:
        return ZappiStatusText.EvDisconnected;
      case ZappiStatus.EvReadyToCharge:
        return ZappiStatusText.EvReadyToCharge;
      case ZappiStatus.Fault:
        return ZappiStatusText.Fault;
      case ZappiStatus.WaitingForEv:
        return ZappiStatusText.WaitingForEv;
      default:
        return ZappiStatusText.EvDisconnected;
    };
  }

  /**
    * onAdded is called when the user adds the device, called just after pairing.
    */
  public async onAdded(): Promise<void> {
    this.log('ZappiDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  public async onSettings({ oldSettings, newSettings, changedKeys }: {
    oldSettings: any;
    newSettings: any;
    changedKeys: string[];
  }): Promise<string | void> {
    const dev: ZappiDevice = this;
    dev.log(`ZappiDevice settings where changed: ${changedKeys}`);
    if (changedKeys.includes('showNegativeValues')) {
      dev._settings.showNegativeValues = newSettings.showNegativeValues;
    }
    if (changedKeys.includes('powerCalculationMode')) {
      dev._settings.powerCalculationMode = newSettings.powerCalculationMode;
      if (newSettings.powerCalculationMode === "automatic") {
        dev._powerCalculationModeSetToAuto = true;
        const zappi = await dev.myenergiClient.getStatusZappi(dev.deviceId);
        if (zappi) {
          dev.log(zappi);
          const tmpSettings: any =
          {
            includeCT1: zappi.ectt1 === 'Internal Load',
            includeCT2: zappi.ectt2 === 'Internal Load',
            includeCT3: zappi.ectt3 === 'Internal Load',
            includeCT4: zappi.ectt4 === 'Internal Load',
            includeCT5: zappi.ectt5 === 'Internal Load',
            includeCT6: zappi.ectt6 === 'Internal Load',
          };

          Object.keys(tmpSettings).forEach(key => dev._settings[key] = tmpSettings[key]);
        }
      } else if (newSettings.powerCalculationMode === "manual") {
        dev._settings.includeCT1 = newSettings.includeCT1;
        dev._settings.includeCT2 = newSettings.includeCT2;
        dev._settings.includeCT3 = newSettings.includeCT3;
        dev._settings.includeCT4 = newSettings.includeCT4;
        dev._settings.includeCT5 = newSettings.includeCT5;
        dev._settings.includeCT6 = newSettings.includeCT6;
      }
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  public async onRenamed(name: any): Promise<void> {
    this.log('ZappiDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  public async onDeleted(): Promise<void> {
    (this.driver as ZappiDriver).removeDataUpdateCallback(this._callbackId);
    this.log('ZappiDevice has been deleted');
  }

}

module.exports = ZappiDevice;

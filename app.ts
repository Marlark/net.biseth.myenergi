import sourceMapSupport from 'source-map-support';
sourceMapSupport.install();

import Homey from 'homey';
import { MyEnergi } from 'myenergi-api';

// Start debuger
//if (process.env.DEBUG === '1') {
//  require('inspector').open(9229, '0.0.0.0', false);
//  require(“inspector”).open(9229, “0.0.0.0”, true);
//}
export class MyEnergiApp extends Homey.App {

  private _dataUpdateInterval: number = 60 * 1000;
  private _dataUpdateId!: NodeJS.Timeout;
  private _dataUpdateCallbacks: any[] = [];
  private _apiBaseUrl: string = 'https://s18.myenergi.net';

  public clients: any;

  private async initClients(hubs: any) {
    this.log(`Starting client init...`);
    if (this.clients) {
      Object.keys(this.clients).forEach((key, i, arr) => {
        this.log(key);
        delete this.clients[key];
      });
    }
    if (hubs) {
      this.clients = {};
      hubs.forEach((hub: any, index: number) => {
        this.log(hub);
        this.clients[`${hub.hubname}_${hub.username}`] = new MyEnergi(hub.username, hub.password, this._apiBaseUrl);
        if (index === 0) {
          this._dataUpdateInterval = hub.pollInterval * 1000;
        }
        this.log(`Added hub ${hub.hubname} with url ${this._apiBaseUrl}`);
      });
    }
    this.log(`Client init complete.`);
  }

  public registerDataUpdateCallback(callback: any) {
    this._dataUpdateCallbacks.push(callback);
  }

  private runDataUpdate() {
    const updateInterval: number = this._dataUpdateInterval / 1000;
    this.log(`Starting scheduled data update. Running every ${updateInterval} seconds.`);
    clearTimeout(this._dataUpdateId);
    if (this.clients) {
      Object.keys(this.clients).forEach(async c => {
        this.log(`Fetching data for ${c}`);
        const client: MyEnergi = this.clients[c] as MyEnergi;
        const data = await client.getStatusAll().catch(this.error);
        if (data)
          this._dataUpdateCallbacks.forEach(callback => {
            callback(data);
          });
      });
    }
    this._dataUpdateId = setTimeout(() => {
      this.runDataUpdate();
    }, this._dataUpdateInterval);
  }

  /**
   * onInit is called when the app is initialized.
   */
  public async onInit() {
    const myenergiHubs = this.homey.settings.get('myenergiHubs');
    const apiBaseUrl = this.homey.settings.get('apiBaseUrl');
    if (apiBaseUrl)
      this._apiBaseUrl = apiBaseUrl;
    this.initClients(myenergiHubs);

    this.homey.settings.on('set', key => {
      if (key === 'apiBaseUrl') {
        const apiBaseUrl = this.homey.settings.get('apiBaseUrl');
        if (apiBaseUrl)
          this._apiBaseUrl = apiBaseUrl;
        this.log(`Saved apiBaseUrl ${this._apiBaseUrl}`);

        const hubs = this.homey.settings.get('myenergiHubs');
        this.initClients(hubs);
      }
      if (key === 'myenergiHubs') {
        const hubs = this.homey.settings.get('myenergiHubs');
        this.initClients(hubs);
      }
    });

    this.runDataUpdate();
    this.log('myenergi app has been initialized');
  }

}

module.exports = MyEnergiApp;

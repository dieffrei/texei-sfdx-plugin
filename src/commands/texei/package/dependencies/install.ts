import { core, SfdxCommand, flags } from '@salesforce/command';
import { watchFile } from 'fs';
const exec = require('child-process-promise').exec;
const spawn = require('child-process-promise').spawn;
const _ = require('underscore');

const packageIdPrefix = '0Ho';
const packageVersionIdPrefix = '04t';
const packageAliasesMap = [];
const defaultWait = 10;

// Initialize Messages with the current plugin directory
core.Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = core.Messages.loadMessages('texei-sfdx-plugin', 'install');

export default class Install extends SfdxCommand {

  public static description = messages.getMessage('commandDescription');

  public static examples = [
    '$ texei:package:dependencies:install -u MyScratchOrg -v MyDevHub -k "1:MyPackage1Key 2: 3:MyPackage3Key" -b "DEV"'
  ];

  protected static flagsConfig = {
    installationkeys: { char: 'k', required: false, description: 'installation key for key-protected packages (format is 1:MyPackage1Key 2: 3:MyPackage3Key... to allow some packages without installation key)' },
    branch: { char: 'b', required: false, description: 'the package version’s branch' },
    namespaces: { char: 'n', required: false, description: 'filter package installation by namespace' },
    wait: { char: 'w', type: 'number', required: false, description: 'number of minutes to wait for installation status (also used for publishwait). Default is 10' },
    noprompt: { char: 'r', required: false, type: 'boolean', description: 'allow Remote Site Settings and Content Security Policy websites to send or receive data without confirmation' }
  };

  // Comment this out if your command does not require an org username
  protected static requiresUsername = true;

  // Comment this out if your command does not require a hub org username
  protected static requiresDevhubUsername = false;

  // Set this to true if your command requires a project workspace; 'requiresProject' is false by default
  protected static requiresProject = true;

  public async run(): Promise<any> {

    const result = { installedPackages: {} };

    const username = this.org.getUsername();
    const project = await core.SfdxProjectJson.retrieve<core.SfdxProjectJson>();

    if (this.flags.namespaces != null) {
      this.ux.log('Filtering by namespaces: ' + this.flags.namespaces);
    }

    const packageAliases = project.get('packageAliases') || {};
    if (typeof packageAliases !== undefined ) {

      Object.entries(packageAliases).forEach(([key, value]) => {
        packageAliasesMap[key] = value;
      });
    }

    // Getting Package
    const packagesToInstall = [];

    const packageDirectories = project.get('packageDirectories') as core.JsonArray || [];

    this.ux.startSpinner('Resolving dependencies');

    for (let packageDirectory of packageDirectories) {
      packageDirectory = packageDirectory as core.JsonMap;

      const dependencies = packageDirectory.dependencies || [];

      // TODO: Move all labels to message
      if (dependencies && dependencies[0] !== undefined) {
        this.ux.log(`\nPackage dependencies found for package directory ${packageDirectory.path}`);
        for (const dependency of (dependencies as core.JsonArray)) {

          const packageInfo = { } as core.JsonMap;

          const dependencyInfo = dependency as core.JsonMap;
          const dependentPackage: string = ((dependencyInfo.packageId != null) ? dependencyInfo.packageId : dependencyInfo.package) as string;
          const versionNumber: string = (dependencyInfo.versionNumber) as string;
          const namespaces: string[] = this.flags.namespaces !== undefined ? this.flags.namespaces.split(',') : null;

          if (dependentPackage == null) {
            throw Error('Dependent package version unknow error.');
          }

          packageInfo.dependentPackage = dependentPackage;
          packageInfo.versionNumber = versionNumber;
          const packageVersionId = await this.getPackageVersionId(dependentPackage, versionNumber, namespaces);
          if (packageVersionId != null) {
            packageInfo.packageVersionId = packageVersionId;
            packagesToInstall.push( packageInfo );
            this.ux.log( `    ${packageInfo.packageVersionId} : ${packageInfo.dependentPackage}${ packageInfo.versionNumber === undefined ? '' : ' ' + packageInfo.versionNumber }`);
          }
        }
      } else {
        this.ux.log(`\nNo dependencies found for package directory ${packageDirectory.path}`);
      }
    }

    this.ux.stopSpinner('Done.');

    if (packagesToInstall.length > 0) { // Installing Packages

      // Getting Installation Key(s)
      let installationKeys = this.flags.installationkeys;
      if (installationKeys) {
        installationKeys = installationKeys.trim();
        installationKeys = installationKeys.split(' ');

        // Format is 1: 2: 3: ... need to remove these
        for (let keyIndex = 0; keyIndex < installationKeys.length; keyIndex++) {

          const key = installationKeys[keyIndex].trim();
          if (key.startsWith(`${keyIndex + 1}:`)) {
            installationKeys[keyIndex] = key.substring(2);
          } else {
            // Format is not correct, throw an error
            throw new core.SfdxError('Installation Key should have this format: 1:MyPackage1Key 2: 3:MyPackage3Key');
          }
        }
      }

      this.ux.log('\n');

      let i = 0;
      for (let packageInfo of packagesToInstall) {
        packageInfo = packageInfo as core.JsonMap;
        if (result.installedPackages.hasOwnProperty(packageInfo.packageVersionId)) {
          this.ux.log(`PackageVersionId ${packageInfo.packageVersionId} already installed. Skipping...`);
          continue;
        }

        // Split arguments to use spawn
        const args = [];

        args.push('force:package:install');

        // USERNAME
        args.push('--targetusername');
        args.push(`${username}`);

        // PACKAGE ID
        args.push('--package');
        args.push(`${packageInfo.packageVersionId}`);

        // INSTALLATION KEY
        if (installationKeys && installationKeys[i]) {
          args.push('--installationkey');
          args.push(`${installationKeys[i]}`);
        }

        // WAIT
        const wait = this.flags.wait ? this.flags.wait.trim() : defaultWait;
        args.push('--wait');
        args.push(`${wait}`);
        args.push('--publishwait');
        args.push(`${wait}`);

        // NOPROMPT
        if (this.flags.noprompt) {
          args.push('--noprompt');
        }

        // INSTALL PACKAGE
        // TODO: How to add a debug flag or write to sfdx.log with --loglevel ?
        this.ux.log(`Installing package ${packageInfo.packageVersionId} : ${packageInfo.dependentPackage}${ packageInfo.versionNumber === undefined ? '' : ' ' + packageInfo.versionNumber }`);

        await this.executeDXCommand(3, args);

        this.ux.log('\n');

        result.installedPackages[packageInfo.packageVersionId] = packageInfo;

        i++;
      }
    }

    return { message: result };
  }

  private async executeDXCommand(attemptsUntilFail: number, args: string[]) {
    if (attemptsUntilFail > 0) {
      try {
        await spawn('sfdx', args, {stdio: 'inherit'});
      } catch (ex) {
        const currentAttempt: number = (3 - attemptsUntilFail) + 1;
        this.ux.log(`Retrying ${currentAttempt} of 3:`);
        await this.executeDXCommand(attemptsUntilFail - 1, args);
      }
    }
  }

  private async getPackageVersionId(name: string, version: string, namespaces: string[]) {

    let packageId = null;
    // Keeping original name so that it can be used in error message if needed
    let packageName = name;

    // TODO: Some stuff are duplicated here, some code don't need to be executed for every package
    // First look if it's an alias
    if (typeof packageAliasesMap[packageName] !== 'undefined') {
      packageName = packageAliasesMap[packageName];
    }

    if (packageName.startsWith(packageVersionIdPrefix)) {
      // Package2VersionId is set directly
      packageId = packageName;
    } /*else if (packageName.startsWith(packageIdPrefix)) {
      // Get Package version id from package + versionNumber
      const vers = version.split('.');
      let query = 'Select SubscriberPackageVersionId, IsPasswordProtected, IsReleased, Package2.NamespacePrefix ';
      query += 'from Package2Version ';
      query += `where Package2Id='${packageName}' and MajorVersion=${vers[0]} and MinorVersion=${vers[1]} and PatchVersion=${vers[2]} `;

      if (namespaces != null) {
        query += ` and Package2.NamespacePrefix IN ('${namespaces.join('\',\'')}')`;
      }

      // If Build Number isn't set to LATEST, look for the exact Package Version
      if (vers[3] !== 'LATEST') {
        query += `and BuildNumber=${vers[3]} `;
      }

      // If Branch is specified, use it to filter
      if (this.flags.branch) {
        query += `and Branch='${this.flags.branch.trim()}' `;
      }

      query += ' ORDER BY BuildNumber DESC Limit 1';

      // Query DevHub to get the expected Package2Version
      const conn = this.hubOrg.getConnection();
      const resultPackageId = await conn.tooling.query(query) as any;

      if (resultPackageId.size > 0) {
        packageId = resultPackageId.records[0].SubscriberPackageVersionId;
      }
    }*/

    this.ux.log(`getPackageVersionId packageId: ${packageId}`);

    return packageId;
  }
}

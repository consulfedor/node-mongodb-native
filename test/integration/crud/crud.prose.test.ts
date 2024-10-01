import { expect } from 'chai';
import { once } from 'events';

import { type CommandStartedEvent } from '../../../mongodb';
import {
  type AnyClientBulkWriteModel,
  type ClientSession,
  type Collection,
  MongoBulkWriteError,
  type MongoClient,
  MongoServerError
} from '../../mongodb';
import { filterForCommands } from '../shared';

describe('CRUD Prose Spec Tests', () => {
  let client: MongoClient;

  beforeEach(async function () {
    client = this.configuration.newClient({ monitorCommands: true });
    await client.connect();
  });

  afterEach(async () => {
    if (client) {
      await client.close();
      client.removeAllListeners();
    }
  });

  // TODO(NODE-3888): Implement this test
  it.skip('1. WriteConcernError.details exposes writeConcernError.errInfo', {
    /**
     * Test that writeConcernError.errInfo in a command response is propagated as WriteConcernError.details (or equivalent) in the driver.
     * Using a 4.0+ server, set the following failpoint:
     * @example
     * ```js
     * {
     *   "configureFailPoint": "failCommand",
     *   "data": {
     *     "failCommands": ["insert"],
     *     "writeConcernError": {
     *       "code": 100,
     *       "codeName": "UnsatisfiableWriteConcern",
     *       "errmsg": "Not enough data-bearing nodes",
     *       "errInfo": {
     *         "writeConcern": {
     *           "w": 2,
     *           "wtimeout": 0,
     *           "provenance": "clientSupplied"
     *         }
     *       }
     *     }
     *   },
     *   "mode": { "times": 1 }
     * }
     * ```
     *
     * Then, perform an insert operation and assert that a WriteConcernError occurs and that
     * its details property is both accessible and matches the errInfo object from the failpoint.
     */
    metadata: { requires: { mongodb: '>=4.0.0' } },
    async test() {
      throw new Error('This test is not implemented!');
    }
  }).skipReason = 'TODO(NODE-3888): Implement this test';

  describe('2. WriteError.details exposes writeErrors[].errInfo', () => {
    /**
     * Test that writeErrors[].errInfo in a command response is propagated as WriteError.details (or equivalent) in the driver.
     * Using a 5.0+ server, create a collection with document validation like so:
     * @example
     * ```js
     * {
     *   "create": "test",
     *   "validator": {
     *     "x": { $type: "string" }
     *   }
     * }
     *```
     * Enable command monitoring to observe CommandSucceededEvents.
     * Then, insert an invalid document (e.g. `{x: 1}`)
     * and assert that a WriteError occurs, that its code is 121 (i.e. DocumentValidationFailure),
     * and that its details property is accessible.
     * Additionally, assert that a CommandSucceededEvent was observed
     * and that the writeErrors[0].errInfo field in the response document matches the WriteError's details property.
     */

    let collection;

    beforeEach(async () => {
      try {
        await client.db().collection('wc_details').drop();
      } catch {
        // don't care
      }

      collection = await client
        .db()
        .createCollection('wc_details', { validator: { x: { $type: 'string' } } });
    });

    it('test case: insert MongoServerError', {
      metadata: { requires: { mongodb: '>=5.0.0' } },
      async test() {
        const evCapture = once(client, 'commandSucceeded');

        let errInfoFromError;
        try {
          await collection.insertOne({ x: /not a string/ });
          expect.fail('The insert should fail the validation that x must be a string');
        } catch (error) {
          expect(error).to.be.instanceOf(MongoServerError);
          expect(error).to.have.property('code', 121);
          expect(error).to.have.property('errInfo').that.is.an('object');
          errInfoFromError = error.errInfo;
        }

        const commandSucceededEvents = await evCapture;
        expect(commandSucceededEvents).to.have.lengthOf(1);
        const ev = commandSucceededEvents[0];
        expect(ev).to.have.nested.property('reply.writeErrors[0].errInfo').that.is.an('object');

        const errInfoFromEvent = ev.reply.writeErrors[0].errInfo;
        expect(errInfoFromError).to.deep.equal(errInfoFromEvent);
      }
    });

    it('test case: insertMany MongoBulkWriteError', {
      metadata: { requires: { mongodb: '>=5.0.0' } },
      async test() {
        const evCapture = once(client, 'commandSucceeded');

        let errInfoFromError;
        try {
          await collection.insertMany([{ x: /not a string/ }]);
          expect.fail('The insert should fail the validation that x must be a string');
        } catch (error) {
          expect(error).to.be.instanceOf(MongoBulkWriteError);
          expect(error).to.have.property('code', 121);
          expect(error).to.have.property('writeErrors').that.is.an('array');
          expect(error.writeErrors[0]).to.have.property('errInfo').that.is.an('object');
          errInfoFromError = error.writeErrors[0].errInfo;
        }

        const commandSucceededEvents = await evCapture;
        expect(commandSucceededEvents).to.have.lengthOf(1);
        const ev = commandSucceededEvents[0];
        expect(ev).to.have.nested.property('reply.writeErrors[0].errInfo').that.is.an('object');

        const errInfoFromEvent = ev.reply.writeErrors[0].errInfo;
        expect(errInfoFromError).to.deep.equal(errInfoFromEvent);
      }
    });
  });

  describe('3. MongoClient.bulkWrite batch splits a writeModels input with greater than maxWriteBatchSize operations', function () {
    // Test that MongoClient.bulkWrite properly handles writeModels inputs containing a number of writes greater than
    // maxWriteBatchSize.
    // This test must only be run on 8.0+ servers. This test must be skipped on Atlas Serverless.
    // Construct a MongoClient (referred to as client) with command monitoring enabled to observe CommandStartedEvents.
    // Perform a hello command using client and record the maxWriteBatchSize value contained in the response. Then,
    // construct the following write model (referred to as model):
    // InsertOne: {
    //   "namespace": "db.coll",
    //   "document": { "a": "b" }
    // }
    // Construct a list of write models (referred to as models) with model repeated maxWriteBatchSize + 1 times. Execute
    // bulkWrite on client with models. Assert that the bulk write succeeds and returns a BulkWriteResult with an
    // insertedCount value of maxWriteBatchSize + 1.
    // Assert that two CommandStartedEvents (referred to as firstEvent and secondEvent) were observed for the bulkWrite
    // command. Assert that the length of firstEvent.command.ops is maxWriteBatchSize. Assert that the length of
    // secondEvent.command.ops is 1. If the driver exposes operationIds in its CommandStartedEvents, assert that
    // firstEvent.operationId is equal to secondEvent.operationId.
    let client: MongoClient;
    let maxWriteBatchSize;
    const models: AnyClientBulkWriteModel[] = [];
    const commands: CommandStartedEvent[] = [];

    beforeEach(async function () {
      client = this.configuration.newClient({}, { monitorCommands: true });
      await client.connect();
      await client.db('db').collection('coll').drop();
      const hello = await client.db('admin').command({ hello: 1 });
      maxWriteBatchSize = hello.maxWriteBatchSize;

      client.on('commandStarted', filterForCommands('bulkWrite', commands));
      commands.length = 0;

      Array.from({ length: maxWriteBatchSize + 1 }, () => {
        models.push({
          namespace: 'db.coll',
          name: 'insertOne',
          document: { a: 'b' }
        });
      });
    });

    afterEach(async function () {
      await client.close();
    });

    it('splits the commands into 2 operations', {
      metadata: { requires: { mongodb: '>=8.0.0', serverless: 'forbid' } },
      async test() {
        const result = await client.bulkWrite(models);
        expect(result.insertedCount).to.equal(maxWriteBatchSize + 1);
        expect(commands.length).to.equal(2);
        expect(commands[0].command.ops.length).to.equal(maxWriteBatchSize);
        expect(commands[1].command.ops.length).to.equal(1);
      }
    });
  });

  describe('4. MongoClient.bulkWrite batch splits when an ops payload exceeds maxMessageSizeBytes', function () {
    // Test that MongoClient.bulkWrite properly handles a writeModels input which constructs an ops array larger
    // than maxMessageSizeBytes.
    // This test must only be run on 8.0+ servers. This test must be skipped on Atlas Serverless.
    // Construct a MongoClient (referred to as client) with command monitoring enabled to observe CommandStartedEvents.
    // Perform a hello command using client and record the following values from the response: maxBsonObjectSize
    // and maxMessageSizeBytes. Then, construct the following document (referred to as document):
    // {
    //   "a": "b".repeat(maxBsonObjectSize - 500)
    // }
    // Construct the following write model (referred to as model):
    // InsertOne: {
    //   "namespace": "db.coll",
    //   "document": document
    // }
    // Use the following calculation to determine the number of inserts that should be provided to
    // MongoClient.bulkWrite: maxMessageSizeBytes / maxBsonObjectSize + 1 (referred to as numModels). This number
    // ensures that the inserts provided to MongoClient.bulkWrite will require multiple bulkWrite commands to be
    // sent to the server.
    // Construct as list of write models (referred to as models) with model repeated numModels times. Then execute
    // bulkWrite on client with models. Assert that the bulk write succeeds and returns a BulkWriteResult with
    // an insertedCount value of numModels.
    // Assert that two CommandStartedEvents (referred to as firstEvent and secondEvent) were observed. Assert
    // that the length of firstEvent.command.ops is numModels - 1. Assert that the length of secondEvent.command.ops
    // is 1. If the driver exposes operationIds in its CommandStartedEvents, assert that firstEvent.operationId is
    // equal to secondEvent.operationId.
    let client: MongoClient;
    let maxBsonObjectSize;
    let maxMessageSizeBytes;
    let numModels;
    const models: AnyClientBulkWriteModel[] = [];
    const commands: CommandStartedEvent[] = [];

    beforeEach(async function () {
      client = this.configuration.newClient({}, { monitorCommands: true });
      await client.connect();
      await client.db('db').collection('coll').drop();
      const hello = await client.db('admin').command({ hello: 1 });
      maxBsonObjectSize = hello.maxBsonObjectSize;
      maxMessageSizeBytes = hello.maxMessageSizeBytes;
      numModels = Math.floor(maxMessageSizeBytes / maxBsonObjectSize + 1);

      client.on('commandStarted', filterForCommands('bulkWrite', commands));
      commands.length = 0;

      Array.from({ length: numModels }, () => {
        models.push({
          name: 'insertOne',
          namespace: 'db.coll',
          document: {
            a: 'b'.repeat(maxBsonObjectSize - 500)
          }
        });
      });
    });

    afterEach(async function () {
      await client.close();
    });

    it('splits the commands into 2 operations', {
      metadata: { requires: { mongodb: '>=8.0.0', serverless: 'forbid' } },
      async test() {
        const result = await client.bulkWrite(models);
        expect(result.insertedCount).to.equal(numModels);
        expect(commands.length).to.equal(2);
        expect(commands[0].command.ops.length).to.equal(numModels - 1);
        expect(commands[1].command.ops.length).to.equal(1);
      }
    });
  });

  describe('7. MongoClient.bulkWrite handles a cursor requiring a getMore', function () {
    // Test that MongoClient.bulkWrite properly iterates the results cursor when getMore is required.
    // This test must only be run on 8.0+ servers. This test must be skipped on Atlas Serverless.
    // Construct a MongoClient (referred to as client) with command monitoring enabled to observe
    // CommandStartedEvents. Perform a hello command using client and record the maxBsonObjectSize value from the response.
    // Construct a MongoCollection (referred to as collection) with the namespace "db.coll" (referred to as namespace).
    // Drop collection. Then create the following list of write models (referred to as models):
    // UpdateOne {
    //   "namespace": namespace,
    //   "filter": { "_id": "a".repeat(maxBsonObjectSize / 2) },
    //   "update": { "$set": { "x": 1 } },
    //   "upsert": true
    // },
    // UpdateOne {
    //   "namespace": namespace,
    //   "filter": { "_id": "b".repeat(maxBsonObjectSize / 2) },
    //   "update": { "$set": { "x": 1 } },
    //   "upsert": true
    // },
    // Execute bulkWrite on client with models and verboseResults set to true. Assert that the bulk write succeeds and returns a BulkWriteResult (referred to as result).
    // Assert that result.upsertedCount is equal to 2.
    // Assert that the length of result.updateResults is equal to 2.
    // Assert that a CommandStartedEvent was observed for the getMore command.
    let client: MongoClient;
    let maxBsonObjectSize;
    const models: AnyClientBulkWriteModel[] = [];
    const commands: CommandStartedEvent[] = [];

    beforeEach(async function () {
      client = this.configuration.newClient({}, { monitorCommands: true });
      await client.connect();
      await client.db('db').collection('coll').drop();
      const hello = await client.db('admin').command({ hello: 1 });
      maxBsonObjectSize = hello.maxBsonObjectSize;

      client.on('commandStarted', filterForCommands('getMore', commands));
      commands.length = 0;

      models.push({
        name: 'updateOne',
        namespace: 'db.coll',
        filter: { _id: 'a'.repeat(maxBsonObjectSize / 2) },
        update: { $set: { x: 1 } },
        upsert: true
      });
      models.push({
        name: 'updateOne',
        namespace: 'db.coll',
        filter: { _id: 'b'.repeat(maxBsonObjectSize / 2) },
        update: { $set: { x: 1 } },
        upsert: true
      });
    });

    afterEach(async function () {
      await client.close();
    });

    it('handles a getMore on the results', {
      metadata: { requires: { mongodb: '>=8.0.0', serverless: 'forbid' } },
      async test() {
        const result = await client.bulkWrite(models, { verboseResults: true });
        expect(result.upsertedCount).to.equal(2);
        expect(result.updateResults.size).to.equal(2);
        expect(commands.length).to.equal(1);
      }
    });
  });

  describe('8. MongoClient.bulkWrite handles a cursor requiring getMore within a transaction', function () {
    // Test that MongoClient.bulkWrite executed within a transaction properly iterates the results
    //  cursor when getMore is required.
    // This test must only be run on 8.0+ servers. This test must be skipped on Atlas Serverless.
    // This test must not be run against standalone servers.
    // Construct a MongoClient (referred to as client) with command monitoring enabled to observe
    // CommandStartedEvents. Perform a hello command using client and record the maxBsonObjectSize value from the response.
    // Construct a MongoCollection (referred to as collection) with the namespace "db.coll" (referred to as namespace). Drop collection.
    // Start a session on client (referred to as session). Start a transaction on session.
    // Create the following list of write models (referred to as models):
    // UpdateOne {
    //   "namespace": namespace,
    //   "filter": { "_id": "a".repeat(maxBsonObjectSize / 2) },
    //   "update": { "$set": { "x": 1 } },
    //   "upsert": true
    // },
    // UpdateOne {
    //   "namespace": namespace,
    //   "filter": { "_id": "b".repeat(maxBsonObjectSize / 2) },
    //   "update": { "$set": { "x": 1 } },
    //   "upsert": true
    // },
    // Execute bulkWrite on client with models, session, and verboseResults set to true. Assert that the bulk
    // write succeeds and returns a BulkWriteResult (referred to as result).
    // Assert that result.upsertedCount is equal to 2.
    // Assert that the length of result.updateResults is equal to 2.
    // Assert that a CommandStartedEvent was observed for the getMore command.
    let client: MongoClient;
    let session: ClientSession;
    let maxBsonObjectSize;
    const models: AnyClientBulkWriteModel[] = [];
    const commands: CommandStartedEvent[] = [];

    beforeEach(async function () {
      client = this.configuration.newClient({}, { monitorCommands: true });
      await client.connect();
      await client.db('db').collection('coll').drop();
      const hello = await client.db('admin').command({ hello: 1 });
      maxBsonObjectSize = hello.maxBsonObjectSize;

      client.on('commandStarted', filterForCommands('getMore', commands));
      commands.length = 0;

      models.push({
        name: 'updateOne',
        namespace: 'db.coll',
        filter: { _id: 'a'.repeat(maxBsonObjectSize / 2) },
        update: { $set: { x: 1 } },
        upsert: true
      });
      models.push({
        name: 'updateOne',
        namespace: 'db.coll',
        filter: { _id: 'b'.repeat(maxBsonObjectSize / 2) },
        update: { $set: { x: 1 } },
        upsert: true
      });

      session = client.startSession();
      session.startTransaction();
    });

    afterEach(async function () {
      await session.endSession();
      await client.close();
    });

    it('handles a getMore on the results in a transaction', {
      metadata: { requires: { mongodb: '>=8.0.0', serverless: 'forbid', topology: '!single' } },
      async test() {
        const result = await client.bulkWrite(models, { verboseResults: true, session });
        expect(result.upsertedCount).to.equal(2);
        expect(result.updateResults.size).to.equal(2);
        expect(commands.length).to.equal(1);
      }
    });
  });

  describe('11. MongoClient.bulkWrite batch splits when the addition of a new namespace exceeds the maximum message size', function () {
    // Test that MongoClient.bulkWrite batch splits a bulk write when the addition of a new namespace to nsInfo causes the size
    // of the message to exceed maxMessageSizeBytes - 1000.
    // This test must only be run on 8.0+ servers. This test must be skipped on Atlas Serverless.
    // Repeat the following setup for each test case:
    // Setup
    // Construct a MongoClient (referred to as client) with command monitoring enabled to observe CommandStartedEvents. Perform
    // a hello command using client and record the following values from the response: maxBsonObjectSize and maxMessageSizeBytes.
    // Calculate the following values:
    // opsBytes = maxMessageSizeBytes - 1122
    // numModels = opsBytes / maxBsonObjectSize
    // remainderBytes = opsBytes % maxBsonObjectSize
    // Construct the following write model (referred to as firstModel):
    // InsertOne {
    //   "namespace": "db.coll",
    //   "document": { "a": "b".repeat(maxBsonObjectSize - 57) }
    // }
    // Create a list of write models (referred to as models) with firstModel repeated numModels times.
    // If remainderBytes is greater than or equal to 217, add 1 to numModels and append the following write model to models:
    // InsertOne {
    //   "namespace": "db.coll",
    //   "document": { "a": "b".repeat(remainderBytes - 57) }
    // }
    // Then perform the following two tests:
    let client: MongoClient;
    let maxBsonObjectSize;
    let maxMessageSizeBytes;
    let opsBytes;
    let numModels;
    let remainderBytes;
    let models: AnyClientBulkWriteModel[] = [];
    const commands: CommandStartedEvent[] = [];

    beforeEach(async function () {
      client = this.configuration.newClient({}, { monitorCommands: true });
      await client.connect();
      await client.db('db').collection('coll').drop();
      const hello = await client.db('admin').command({ hello: 1 });
      maxBsonObjectSize = hello.maxBsonObjectSize;
      maxMessageSizeBytes = hello.maxMessageSizeBytes;
      opsBytes = maxMessageSizeBytes - 1122;
      numModels = Math.floor(opsBytes / maxBsonObjectSize);
      remainderBytes = opsBytes % maxBsonObjectSize;

      client.on('commandStarted', filterForCommands('bulkWrite', commands));
      commands.length = 0;
      models = [];

      Array.from({ length: numModels }, () => {
        models.push({
          namespace: 'db.coll',
          name: 'insertOne',
          document: { a: 'b'.repeat(maxBsonObjectSize - 57) }
        });
      });

      if (remainderBytes >= 217) {
        numModels++;
        models.push({
          namespace: 'db.coll',
          name: 'insertOne',
          document: { a: 'b'.repeat(remainderBytes - 57) }
        });
      }
    });

    afterEach(async function () {
      await client.close();
    });

    context('when no batch splitting is required', function () {
      // Case 1: No batch-splitting required
      // Create the following write model (referred to as sameNamespaceModel):
      // InsertOne {
      //   "namespace": "db.coll",
      //   "document": { "a": "b" }
      // }
      // Append sameNamespaceModel to models.
      // Execute bulkWrite on client with models. Assert that the bulk write succeeds and returns a BulkWriteResult (referred to as result).
      // Assert that result.insertedCount is equal to numModels + 1.
      // Assert that one CommandStartedEvent was observed for the bulkWrite command (referred to as event).
      // Assert that the length of event.command.ops is numModels + 1. Assert that the length of event.command.nsInfo is 1.
      // Assert that the namespace contained in event.command.nsInfo is "db.coll".
      it('executes in a single batch', {
        metadata: { requires: { mongodb: '>=8.0.0', serverless: 'forbid' } },
        async test() {
          const sameNamespaceModel: AnyClientBulkWriteModel = {
            name: 'insertOne',
            namespace: 'db.coll',
            document: { a: 'b' }
          };
          const testModels = models.concat([sameNamespaceModel]);
          const result = await client.bulkWrite(testModels);
          expect(result.insertedCount).to.equal(numModels + 1);
          expect(commands.length).to.equal(1);
          expect(commands[0].command.ops.length).to.equal(numModels + 1);
          expect(commands[0].command.nsInfo.length).to.equal(1);
          expect(commands[0].command.nsInfo[0].ns).to.equal('db.coll');
        }
      });
    });

    context('when batch splitting is required', function () {
      // Case 2: Batch-splitting required
      // Construct the following namespace (referred to as namespace):
      // "db." + "c".repeat(200)
      // Create the following write model (referred to as newNamespaceModel):
      // InsertOne {
      //   "namespace": namespace,
      //   "document": { "a": "b" }
      // }
      // Append newNamespaceModel to models.
      // Execute bulkWrite on client with models. Assert that the bulk write succeeds and returns a BulkWriteResult (referred to as result).
      // Assert that result.insertedCount is equal to numModels + 1.
      // Assert that two CommandStartedEvents were observed for the bulkWrite command (referred to as firstEvent and secondEvent).
      // Assert that the length of firstEvent.command.ops is equal to numModels. Assert that the length of firstEvent.command.nsInfo
      // is equal to 1. Assert that the namespace contained in firstEvent.command.nsInfo is "db.coll".
      // Assert that the length of secondEvent.command.ops is equal to 1. Assert that the length of secondEvent.command.nsInfo
      // is equal to 1. Assert that the namespace contained in secondEvent.command.nsInfo is namespace.
      it('executes in multiple batches', {
        metadata: { requires: { mongodb: '>=8.0.0', serverless: 'forbid' } },
        async test() {
          const namespace = `db.${'c'.repeat(200)}`;
          const newNamespaceModel: AnyClientBulkWriteModel = {
            name: 'insertOne',
            namespace: namespace,
            document: { a: 'b' }
          };
          const testModels = models.concat([newNamespaceModel]);
          const result = await client.bulkWrite(testModels);
          expect(result.insertedCount).to.equal(numModels + 1);
          expect(commands.length).to.equal(2);
          expect(commands[0].command.ops.length).to.equal(numModels);
          expect(commands[0].command.nsInfo.length).to.equal(1);
          expect(commands[0].command.nsInfo[0].ns).to.equal('db.coll');
          expect(commands[1].command.ops.length).to.equal(1);
          expect(commands[1].command.nsInfo.length).to.equal(1);
          expect(commands[1].command.nsInfo[0].ns).to.equal(namespace);
        }
      });
    });
  });

  describe('14. `explain` helpers allow users to specify `maxTimeMS`', function () {
    let client: MongoClient;
    const commands: CommandStartedEvent[] = [];
    let collection: Collection;

    beforeEach(async function () {
      client = this.configuration.newClient({}, { monitorCommands: true });
      await client.connect();

      await client.db('explain-test').dropDatabase();
      collection = await client.db('explain-test').createCollection('collection');

      client.on('commandStarted', filterForCommands('explain', commands));
      commands.length = 0;
    });

    afterEach(async function () {
      await client.close();
    });

    it('sets maxTimeMS on explain commands, when specified', async function () {
      await collection
        .find(
          { name: 'john doe' },
          {
            explain: {
              maxTimeMS: 2000,
              verbosity: 'queryPlanner'
            }
          }
        )
        .toArray();

      const [{ command }] = commands;
      expect(command).to.have.property('maxTimeMS', 2000);
    });
  });
});

const { Sequelize, DataTypes, Model, Op } = require('sequelize');

module.exports = function(url) {
  const sequelize = new Sequelize(url, { logging: false });
  
  // MODELS

  class Currency extends Model {}
  Currency.init({
    code: {
      type: DataTypes.STRING(10),
      allowNull: false,
      unique: true
    },
    exchangeRate: {
      type: DataTypes.DOUBLE,
    }
  },
  {
    modelName: 'Currency',
    tableName: 'currencies',
    sequelize,
    timestamps: true,
    updatedAt: false
  })

  class Account extends Model {}
  Account.init({
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    path: {
      type: DataTypes.VIRTUAL,
      get() { return this.fullName.split(':') }
    },
    fullName: {
      type: DataTypes.STRING(1024),
      allowNull: false
    }

  }, {
    modelName: 'Account',
    tableName: 'accounts',
    sequelize,
    hooks: {
      beforeValidate: async function(account, options) {
        async function findParentOf(account) {
          let parent = await account.getParent();
          let parents = []
          if (parent) { parents = parents.concat(await findParentOf(parent), parent) }
          return parents
        }
        let accounts = [...(await findParentOf(account)), account]
        let accountPath = accounts.map(acc => acc.name)
        account.fullName = accountPath.join(':');
      }
    },
    timestamps: true,
    updatedAt: false
  })

  class Transaction extends Model {}
  Transaction.init({
    amount: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    credit: {
      type: DataTypes.BOOLEAN,
      allowNull: false
    },
    memo: {
      type: DataTypes.STRING(1024),
    },
    meta: {
      type: DataTypes.JSONB
    },
    exchangeRate: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 1
    }
  }, {
    modelName: 'Transaction',
    tableName: 'transactions',
    sequelize,
    timestamps: true,
    updatedAt: false
  })

  class JournalEntry extends Model {}
  JournalEntry.init({}, {
    modelName: 'JournalEntry',
    tableName: 'journalEntries',
    sequelize,
    timestamps: true,
    updatedAt: false
  })

  class Balance extends Model {}
  Balance.init({
    amount: {
      type: DataTypes.BIGINT,
    }
  }, {
    modelName: 'Balance',
    tableName: 'balances',
    sequelize,
    timestamps: true,
    updatedAt: false
  })

  // ASSOCIATIONS

  Account.Currency =         Account.belongsTo(Currency, {as: 'currency'});

  Account.Parent =           Account.belongsTo(Account, {as: 'parent'});

  Account.Transaction =      Account.hasMany(Transaction, {as: 'transactions', foreignKey: 'accountId'})
  Transaction.Account =      Transaction.belongsTo(Account, {as: 'account', foreignKey: 'accountId'});

  JournalEntry.Transaction = JournalEntry.hasMany(Transaction, {as: 'transactions', foreignKey: 'journalId'});
  Transaction.JournalEntry = Transaction.belongsTo(JournalEntry, {as: 'journal', foreignKey: 'journalId'});

  Balance.Account =          Balance.belongsTo(Account, {as: 'account'});

  Balance.Transaction =      Balance.belongsTo(Transaction, {as: 'transaction'});

  return {
    Currency,
    Account,
    Transaction,
    JournalEntry,
    Balance,
    sequelize
  }
}

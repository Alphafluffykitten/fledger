const { Op } = require('sequelize');
const { FError } = require('./errors.js');
const BN = require('bignumber.js');

const NEAR_ZERO = BN(1).shiftedBy(-10);

class SafeAccount {
  constructor(dbAcc, children) {
    this.name = dbAcc.name
    this.fullName = dbAcc.fullName
    this.path = dbAcc.path
    if (dbAcc.currency) {
      this.currency = dbAcc.currency.code
    }
    if (children) {
      this.children = children
    }
  }
}

class RichTransaction {
  constructor(tx) {
    this.id = tx.id,
    this.accountName = tx.account.fullName,
    this.accountPath = tx.account.path,
    this.amount = tx.amount,
    this.credit = tx.credit,
    this.currency = tx.account.currency.code,
    this.exchangeRate = tx.exchangeRate,
    this.memo = tx.memo,
    this.meta = tx.meta,
    this.createdAt = tx.createdAt
  }
}

class Book {
  constructor(db) {
    this.db = db
  }

  async init() {
    await this.db.sequelize.sync({alter: true})
  }

  async close() {
    await this.db.sequelize.close();
  }

  entry(memo) {
    return new Entry(memo, this)
  }

  /**
   * Finds account by its name. If account not found, returns null.
   * @param {string} account - account name in string notation, ex.: 'Assets:usdt' 
   * @returns {db.Account} - db.Account (currency included), or null.
   */
  async _findAccount(account) {
    let accPath = this._makeAccountPath(account);
    let parentId = null;
    let dbAcc;
    for (let acc of accPath) {
      dbAcc = await this.db.Account.findOne({where: {name: acc, parentId}, include: 'currency'})
      if (!dbAcc) { return }
      parentId = dbAcc.id
    }
    return dbAcc
  }

  _makeAccountPath(account) {
    if (!account) { throw new FError('No account provided') }
    if (typeof account != 'string') { throw new FError('Account name should be string') }
    let accPath = account.split(':');
    if (!accPath.length) { throw new FError(`Wrong account ${account}`) }
    return accPath
  }

  /**
   * Finds currency in DB by its code. If no code specified, returns base currency
   * @param {String} [code] - currency code like 'USD' 
   * @returns {db.Currency}
   */
  async _findCurrency(code) {
    if (!code) { return await this.db.Currency.findByPk(1) }
    if (typeof code != 'string') { throw FError('Currency code not string') }
    return await this.db.Currency.findOne({where: {code}})
  }

  /**
   * Counts isolated account balance (without subaccounts) and writes cache row to balances table
   * @param {db.Account} account
   * @returns balance as BN object
   */
  async _isolatedBalance(account) {
    // we'll start summing up to balance from txId = 0 ...
    let fromTxId = 0
    // ... unless there is cached row in DB for this account
    let dbBal = await this.db.Balance.findOne({
      where: {accountId: account.id},
      order: [['id', 'DESC']]
    })
    if (dbBal) {
      // if have cached balance row, take its txId, 
      fromTxId = dbBal.transactionId;
    }

    // fetch all txs for this account with id > fromTxId
    let txs = await this.db.Transaction.findAll({
      where: {
        accountId: account.id,
        id: { [Op.gt]: fromTxId }
      },
      order: [['id', 'DESC']]
    });

    // sum txs minding credit/debit
    let sum = BN(0);
    for (let tx of txs) {
      let amount = tx.credit ? BN(tx.amount).negated() : BN(tx.amount);
      sum = sum.plus(amount);
    }

    // add previous cached amount if there is
    if (dbBal) {
      sum = sum.plus(dbBal.amount)
    }

    if (txs.length) {
      // write cache row to balances table
      await this.db.Balance.create({ amount: sum.toString(), accountId: account.id, transactionId: txs[0].id })
    }

    return sum
  }

  /**
   * @param {db.Account} account 
   * @param {Date} startDate 
   * @param {Date} endDate 
   * @returns {RichTransaction[]} array of RichTransaction objects for account (without descendants)
   */
  async _isolatedHistory(account, startDate, endDate, meta) {
    let txs = await account.getTransactions({
      where: {
        createdAt: { [Op.between]: [startDate, endDate] },
        meta
      },
      include: {
        association: 'account',
        include: 'currency'
      }
    })

    // turn nested db.Transaction objects with includes into RichTransaction representation:
    // {id, accountName, accountPath, amount, credit, currency, exchangeRate, memo, meta, createdAt}
    txs = txs.map((tx) => { return new RichTransaction(tx) })

    return txs
  }

  /**
   * Finds all subaccounts of account as flat array
   * @param {db.Account} account - pass null to retreive all accounts tree from root
   * @returns {db.Account[]} flat array of subaccounts
   */
  async _findSubaccounts(account) {
    let strBegin
    if (account) { strBegin = `${account.fullName}:` }
    else { strBegin = '' }

    let accs = await this.db.Account.findAll({
      where: { 
        fullName: { [Op.startsWith]: strBegin }
      },
      order: [['fullName', 'ASC']],
      include: 'currency'
    })

    return accs
  }

  /**
   * Creates currency
   * @param {string} code - Currency code, like 'USD' 
   */
  async createCurrency(code) {
    // currency exists?
    if (await this._findCurrency(code)) { throw new FError(`Currency ${code} already exists`) }

    if (!code) { throw new FError('No currency code provided') }
    if (typeof code != 'string') { throw new FError('Code not string') }
    if (code.length > 10) { throw new FError('Code 10 chars max') }
  
    await this.db.Currency.create({code})
    return true
  }

  /**
   * Checks for currency presence in DB, returns object like {code, exchangeRate} or null if not found
   * @param {string} code - currency code
   * @returns {Object|undefined}
   */
  async checkCurrency(code) {
    let dbCur = await this._findCurrency(code)
    if (!dbCur) {return}
    return { code: dbCur.code, exchangeRate: dbCur.exchangeRate }
  }

  /**
   * Creates account. Non-recursive.
   * @param {string} name - Account name in common string notation (like 'Assets:banks:huntington').
   *  If account is on root level (like 'Assets'), it's just created.
   *  If it's a child account (like 'Assets:banks:huntington'), method tries to create the deepest child ('huntington'), while parents should exist (in this example 'Assets:banks' should already exist)
   * @param {string} [currency] - account currency. If not specified, base currency is used
   */
  async createAccount(name, currency) {
    if (!name) { throw new FError('Name not specified') }
    if (typeof name != 'string') { throw new FError('Name not string') }
    if (name.length > 1024) { throw new FError('Name should be <= 255 chars') }
    let re = /[^\w:]/
    if (re.test(name)) { throw new FError('Name should contain alphanumeric chars and semi-colons as delimeters of account names') }

    let accountPath = name.split(':')
    let nameCreated = accountPath[accountPath.length-1]
    if (nameCreated.length > 255) { throw new FError('Account name cannot be > 255 chars') }

    // check for doubling
    if (await this._findAccount(name)) { throw new FError(`Account ${name} already exists`)}

    let parent = null
    if (accountPath.length > 1) { parent = accountPath.slice(0, accountPath.length-1).join(':') }

    let parentId = null
    if (parent) {
      let parentDb = await this._findAccount(parent);
      if (!parentDb) { throw new FError(`Parent account ${parent} not found on DB`)}
      parentId = parentDb.id
    }

    // if currency not set, fill find base currency with id=1
    let dbCurrency = await this._findCurrency(currency)
    if (!dbCurrency) { throw new FError(`Currency ${currency} not found`) }

    await this.db.Account.create({name: nameCreated, currencyId: dbCurrency.id, parentId})
    return true
  }

  /**
   * Checks for account presence in DB
   * @param {string} name - account name in common string notation (Ex.: 'Assets:bank')
   * @returns {SafeAccount|null} If account is found on DB, returns object {name, path, fullName, currency}
   *  Otherwise returns null
   */
  async checkAccount(name) {
    let dbAcc = await this._findAccount(name)
    if (!dbAcc) { return }
    return new SafeAccount(dbAcc)
  }

  /**
   * Returns subaccounts tree of parent account passed in params. Pass null to retrieve all accounts tree. 
   * @param {String} parent - parent account name in common string notation (Ex.: 'Assets:bank') 
   * @returns array of SafeAccount objects with children
   */
  async getAccounts(parent) {
    let parentDb = null
    let parentId = null
    if (parent) { 
      parentDb = await this._findAccount(parent)
      parentId = parentDb.id
    }
    let accs = await this._findSubaccounts(parentDb)

    // turn flat array of subaccounts into tree    
    function findChildren(id) {
      let children = accs.filter(acc => acc.parentId == id)
      children = children.map((child) => { return new SafeAccount(child, findChildren(child.id)) })
      return children
    }

    let tree = findChildren(parentId)
    return tree
  }
  
  /**
   * @param {String} account - account in common string notation (Ex.: 'Assets:bank')
   * @returns {String} Cumulative balance of this account AND its descendant accounts
   */
  async balance(account) {
    // find account in question
    let dbAcc = await this._findAccount(account);
    if (!dbAcc) { throw new FError(`Account ${account} not found on DB`) }

    // find all subaccounts of account and make array of all accounts in question
    let accounts = [dbAcc, ...(await this._findSubaccounts(dbAcc))]
    // accumulate balance with respect to exchange rates
    let balance = BN(0)
    for (let acc of accounts) {
      let baseCurrencyBal = await this._isolatedBalance(acc);
      if (acc.currency.id != 1) { baseCurrencyBal = baseCurrencyBal.div(BN(acc.currency.exchangeRate)) }
      balance = balance.plus(baseCurrencyBal)
    }
    
    return balance.toString();
  }

  /**
   * Ledger history query.
   * @param {String} account - account to get transactions from. Transactions are fetched for this account AND all its descendants
   * @param {Object} [options]
   * @param {Date} [options.startDate] - start date (default - new Date(0))
   * @param {Date} [options.endDate] - end date (default - now)
   * @param {Number} [options.offset] - pagination offset
   * @param {Number} [options.limit] - pagination limit
   * @param {String} [options.order] - order. Can be 'desc' or 'asc', default - 'desc' (newest first)
   * @param {Object} [meta] Meta info to filter transactions.
   *  (Ex.: pass {type: 'userSetHold' , holdId: 1} to obtain only txs of type 'userSetHold' with holdId == 1) 
   * @returns array of RichTransaction objects: {id, accountName, accountPath, amount, credit, currency, exchangeRate, memo, meta, createdAt}[]
   */
  async ledger(account, meta, options) {
    let dbAcc = await this._findAccount(account)
    if (!dbAcc)  { throw new FError(`Account ${account} not found on DB`) }
    let accounts = [dbAcc, ...(await this._findSubaccounts(dbAcc))]

    let startDate = new Date(0)
    let endDate = new Date()
    let offset = 0;
    let limit;
    let order = 'DESC';
    if (options) {
      if (options.startDate) {
        if (!options.startDate instanceof Date) { throw new FError('options.startDate should be of Date type') }
        startDate = options.startDate;
      }
      if (options.endDate) {
        if (!options.endDate instanceof Date) { throw new FError('options.endDate should be of Date type') }
        endDate = options.endDate;
      }
      if (startDate > endDate) {
        throw new FError(`options.startDate ${startDate.toString()} should go before options.endDate ${endDate.toString()}`)
      }
      if (options.offset) {
        let _offset = Number(options.offset)
        if (isNaN(_offset) || !Number.isInteger(_offset) || _offset < 0) { throw new FError('options.offset should be integer number >= 0') }
        offset = _offset
      }
      if (options.limit) {
        let _limit = Number(options.limit)
        if (isNaN(_limit) || !Number.isInteger(_limit) || _limit < 0) { throw new FError('options.limit should be integer number >= 0') }
        limit = _limit
      }
      if (options.order) {
        let _order = options.order;
        if (typeof _order != 'string') { throw new FError('options.order should be string') }
        _order = _order.toUpperCase()
        if (_order == 'DESC') { order = 'DESC' } else if (_order == 'ASC') { order = 'ASC' }
      }
    }

    if (meta) {
      if (typeof meta != 'object') { throw new FError('meta should be object') }
    } else { meta = {} }
    
    // collect account ids to look txs for
    let accIds = accounts.map(acc => acc.id)

    let txs = await this.db.Transaction.findAll({
      where: {
        accountId: accIds,
        createdAt: { [Op.between]: [startDate, endDate] },
        meta
      }, 
      order: [['createdAt', order]],
      include: {
        association: 'account',
        include: 'currency'
      },
      offset, 
      limit
    })
    txs = txs.map((tx) => { return new RichTransaction(tx) })

    return txs
  }

  /**
   * Returns change of trading balance account for selected dates.
   * If dates not specified, calculated accross all transactions, be careful.
   * Results are not cached.
   * @param {object} [options] 
   * @param {Date} [options.startDate] - start date (default - new Date(0))
   * @param {Date} [options.endDate] - end date (default - now)
   * @returns {object} Object like this:
   *  {
   *    currency: { USD: <USD balance in string>, ... },
   *    base: <change of trading balance converted to base currency, in string>
   *  }
   */
  async tradingBalance(options) {
    let startDate = new Date(0)
    let endDate = new Date()
    if (options) {
      if (options.startDate) {
        if (!options.startDate instanceof Date) { throw new FError('options.startDate should be of Date type') }
        startDate = options.startDate;
      }
      if (options.endDate) {
        if (!options.endDate instanceof Date) { throw new FError('options.endDate should be of Date type') }
        endDate = options.endDate;
      }
      if (startDate > endDate) {
        throw new FError(`options.startDate ${startDate.toString()} should go before options.endDate ${endDate.toString()}`)
      }
    }

    let tb = { currency: {}, base: BN(0) }

    // fetch currencies list
    let currencies = await this.db.Currency.findAll()

    // for each currency fetch its debits and credits sum and calculate difference
    for (let currency of currencies) {
      let txs
      txs = await this.db.Transaction.findAll({
        where: {
          '$account.currencyId$': currency.id,
          credit: true,
          createdAt: { [Op.between]: [startDate, endDate] }
        },
        include: 'account'
      })
      let credits = BN(0);
      for (let tx of txs) { credits = credits.plus(tx.amount) }

      txs = await this.db.Transaction.findAll({
        where: {
          '$account.currencyId$': currency.id,
          credit: false,
          createdAt: { [Op.between]: [startDate, endDate] }
        },
        include: 'account'
      })
      let debits = BN(0)
      for (let tx of txs) { debits = debits.plus(tx.amount) }

      // calculate currency balance
      let diff = debits.minus(credits)

      tb.currency[currency.code] = diff.toString();
      // collect base currency balance over all currencies 
      tb.base = tb.base.plus(diff.div(currency.exchangeRate))
    }

    tb.base = tb.base.toString()

    return tb
  }
}

class Entry {
  constructor(memo, book) {
    if (!memo) { memo = '' }
    if (typeof memo != 'string') { throw new FError('Memo not a string') }
    if (memo.length > 1024) { throw new FError('Memo longer than 1024') }

    this.entry = { memo, debits: [], credits: [] }
    this._committed = false;
    this.book = book
  }

  /**
   * Creates debit element for this book entry
   * @param {string} account - Account string representation, like 'UserAccounts:1:spendable' 
   * @param {(number|string)} amount
   * @param {Object} [meta = {}] - Meta info object
   * @param {number} [exchangeRate = 1.0] - exchange rate (divisor) for accounts denominated in foreign currencies. Divisor means that foreign currency is divided by it to obtain home currency
   */
  debit(account, amount, meta, exchangeRate) {
    return this._debit_credit('debits', account, amount, meta, exchangeRate)
  }

  /**
   * Creates credit element for this book entry
   * @param {string} account - Account string representation, like 'UserAccounts:1:spendable' 
   * @param {(number|string)} amount
   * @param {Object} [meta = {}] - Meta info object
   * @param {number} [exchangeRate = 1.0] - exchange rate (divisor) for accounts denominated in foreign currencies. Divisor means that foreign currency is divided by it to obtain home currency
   */
   credit(account, amount, meta, exchangeRate) {
    return this._debit_credit('credits', account, amount, meta, exchangeRate)
  }

  /**
   * Creates debit or credit element for this book entry
   * @param {string} direction - Can be 'debits' or 'credits'
   * @param {string} account - Account string representation, like 'UserAccounts:1:spendable' 
   * @param {(number|string)} amount
   * @param {Object} [meta = {}] - Meta info object
   * @param {number} [exchangeRate = 1.0] - exchange rate (divisor) for accounts denominated in foreign currencies. Divisor means that foreign currency is divided by it to obtain home currency
   */
  _debit_credit(direction, account, amount, meta, exchangeRate) {
    if (typeof account != 'string') { throw new FError('Account not string') }

    amount = BN(amount);
    if (amount.lte(0)) { throw new FError('Amount should be > 0') }
    if (!amount.isInteger()) { throw new FError('Amount is not integer') }

    if (exchangeRate) {
      exchangeRate = BN(exchangeRate);
      if (exchangeRate.isNaN()) { throw new FError('Exchange rate is not a number') }
      if (exchangeRate.lte(0)) { throw new FError('Exchange rate should be > 0') }
    }

    if (!meta) { meta = {} }
    if (typeof meta != 'object') { throw new FError('meta is not object') }

    this.entry[direction].push({account, amount, meta, exchangeRate})
    return this
  }

  /**
   * Checks that accounts listed in entry present in Accounts table.
   * Replaces string account properties in credit and debit directions with their db.Account representations.
   */
  async _findAccounts() {
    for (let direction of ['debits', 'credits']) {
      for (let el of this.entry[direction]) {
        // we have el - element of one direction
        // lets find account of this el in DB
        let dbAcc = await this.book._findAccount(el.account);
        if (!dbAcc) { throw new FError(`Account ${el.account} not found on DB`) }
        el.account = dbAcc
      }
    }
  }

  _setExchangeRates() {
    for (let direction of ['debits', 'credits']) {
      for (let el of this.entry[direction]) {
        // if tx in base currency, ignore user-set rate and set 1.0
        if (el.account.currency.id == 1) {
          el.exchangeRate = BN(1)
        // for non-base currencies: if rate wasn't set in entry, try to find it in DB cached
        } else if (!el.exchangeRate) {
          let rate = el.account.currency.exchangeRate
          if (!rate) { throw new FError(`Cannot find exchange rate for account ${el.account.fullName} in book entry, nor in DB. Perhaps no txs was made with this currency before`) }
          el.exchangeRate = rate
        }
      }
    }
  }

  /**
   * Checks entry's balance
   * @throws If entry not balanced
   */
  _checkBalance() {
    function sumDirection(direction) {
      let sum = BN(0)
      for (let el of direction) {
        sum = sum.plus(el.amount.div(el.exchangeRate))
      }
      return sum
    }

    let creditSum = sumDirection(this.entry.credits);
    let debitSum = sumDirection(this.entry.debits);
    if (creditSum.minus(debitSum).abs().gte(NEAR_ZERO)) {
      throw new FError(`Entry not balanced. Credit sum: ${creditSum.toString()}, debit sum: ${debitSum.toString()}`)
    }
  }

  /**
   * Makes DB transactions of the entry.
   * Entry looks like this:
   * {
   *  debits: [{account, amount, meta, exchangeRate}, ...],
   *  credits: [{account, amount, meta, exchangeRate}, ...],
   *  memo
   * }
   * @returns {Object[]} Transactions array that looks like this: {amount, credit, accountId, memo, meta, exchangeRate}[]
   */
  _makeTransactions() {
    let txs = []
    for (let direction of ['debits', 'credits']) {
      let credit = direction == 'credits'
      for (let el of this.entry[direction]) {
        // el - element of one direction: {account, amount, meta, exchangeRate}
        txs.push({
          amount: el.amount.toString(), 
          credit, 
          accountId: el.account.id,
          memo: this.entry.memo,
          meta: el.meta,
          exchangeRate: el.exchangeRate.toString()
        })
      }
    }
    return txs
  }

  /**
   * Updates exchange rates for all currencies listed in txs of entry  
   * Called after transactions are committed
   */
  async _updateCurrency() {
    if (!this._committed) { throw new FError('Cannot update exchange rates before entry committed') }

    // this will accumulate updates for all currencise listed in this entry's txs
    // also holds the currency object itself
    let currencyUpdates = {}
    
    for (let direction of ['debits', 'credits']) {
      for (let el of this.entry[direction]) {
        let currency = el.account.currency;
        if (!currencyUpdates[currency.code]) {
          currencyUpdates[currency.code] = { exchangeRate: null, currency }
        }
        // update currency's exchange rate
        if (currency.id != 1) {
          currencyUpdates[currency.code].exchangeRate = el.exchangeRate.toString();
        } else {
          currencyUpdates[currency.code].exchangeRate = '1'
        }
      }
    }

    for (let code in currencyUpdates) {
      currencyUpdates[code].currency.exchangeRate = currencyUpdates[code].exchangeRate;
      await currencyUpdates[code].currency.save()
    }
  }

  async commit() {
    if (this._committed) { throw new FError('This entry is already committed') }

    await this._findAccounts()
    this._setExchangeRates()
    this._checkBalance()
    let transactions = this._makeTransactions();

    // entry balanced, lets commit transactions
    await this.book.db.JournalEntry.create({ transactions }, {
      include: [{association: this.book.db.JournalEntry.Transaction, as: 'transactions'}]
    })

    this._committed = true

    // for all transactions update currency.exchangeRate and currency.tradingBalance
    await this._updateCurrency();
  }
}

module.exports = Book
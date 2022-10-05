const chai = require('chai');
const expect = chai.expect
chai.use(require('chai-as-promised'))


describe('Fledger tests', function() {
  let book;

  // HOOKS

  before(async function() {
    // sequelize takes time to start
    this.timeout(20000);
    book = require('../fledger.js')(`${process.env.postgresUri}/fledgerTest`)
    await book.init()
  })

  // drop tables
  after(async function() {
    this.timeout(10000);
    await book.db.sequelize.drop();
    await book.close();
  })
  

  // TESTS
  
  it('create currencies', async function() {
    await book.createCurrency('USD')
    await book.createCurrency('RUB')
  })

  it('create accounts', async function() {
    await book.createAccount('Assets', 'USD')
    await book.createAccount('usdt', 'USD', 'Assets')
    await book.createAccount('bank', 'USD', 'Assets')
    await book.createAccount('AlfaBank', 'RUB', 'Assets:bank')
    await book.createAccount('Huntington', 'USD', 'Assets:bank')
    await book.createAccount('UserBalances', 'USD')
    await book.createAccount('1', 'USD', 'UserBalances')
  })

  context('Transactions', function() {
    it('user 1 top up', async function() {
      await book.entry('User 1 top up')
      .debit('Assets:usdt', 10000, {type: 'userTopUp'})
      .credit('UserBalances:1', 10000, {type: 'userTopUp'})
      .commit()
    })
    
    it('throw on create Tx for non existing account', async function() {
      await expect(
        book.entry('User 2 top up')
          .debit('Assets:usdt', 10000, {type: 'userTopUp'})
          .credit('UserBalances:2', 10000, {type: 'userTopUp'})
          .commit()
      ).to.be.rejectedWith('Account UserBalances:2 not found on DB')
    })  

    it('partial transfer usdt to huntington', async function() {
      await book.entry('Transfer')
      .credit('Assets:usdt', 9500)
      .debit('Assets:bank:Huntington', 9500)
      .commit()
    })

    it('user 1 RUB top up', async function() {
      await book.entry('User 1 RUB top up')
      .debit('Assets:bank:AlfaBank', 600300, {type: 'userTopUp'}, 60.03)
      .credit('UserBalances:1', 10000, {type: 'userTopUp'})
      .commit()
    })
  })

  context('Balances', function() {
    it('leaf asset account', async function() {
      await expect(book.balance('Assets:usdt')).to.be.eventually.equal('500')
    })

    it('leaf liability account', async function() {
      await expect(book.balance('UserBalances:1')).to.be.eventually.equal('-20000')
    })

    it('stem asset account with foreign currencies', async function() {
      await expect(book.balance('Assets:bank')).to.eventually.equal('19500')
    })
  })

  context('History', function() {
    it('history in desc', async function() {
      let txs = await book.ledger('Assets');
      expect(txs.length).to.equal(4)
      expect(txs[0].id).to.equal(5)
      expect(txs[txs.length-1].id).to.equal(1)
    })

    it('history in asc', async function() {
      let txs = await book.ledger('Assets', null, {order: 'asc'})
      expect(txs[0].id).to.equal(1)
      expect(txs[txs.length-1].id).to.equal(5)
    })

    it('pagination', async function() {
      let txs = await book.ledger('Assets', null, {limit: 1})
      expect(txs.length).to.equal(1)
      expect(txs[0].id).to.equal(5)
    })

    it('meta filtering', async function() {
      let txs = await book.ledger('Assets', { type: 'userTopUp' })
      expect(txs.length).to.equal(2)
    })
  })

  xcontext('Helpers', function() {
    xit('list accounts', async function() {
      console.log(JSON.stringify(await book.getAccounts(), null, 2))
    })
  })

  context('MultiCurrency', function() {
    it('change the RUB rate', async function() {
      await book.entry('User 1 RUB top up')
      .debit('Assets:bank:AlfaBank', 700000, {type: 'userTopUp'}, 70)
      .credit('UserBalances:1', 10000, {type: 'userTopUp'})
      .commit()
    })

    it('currencies trading balances', async function() {
      let rubTB = (await book._findCurrency('RUB')).tradingBalance;
      let usdTB = (await book._findCurrency('USD')).tradingBalance;

      expect(rubTB).to.be.equal('1300300')
      expect(usdTB).to.be.equal('-20000')
    })
  })
})
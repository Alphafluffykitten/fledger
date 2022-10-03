const { FError } = require('./errors.js');


module.exports = function(url) {
  if (!url) { throw new FError('No DB connection url') }
  if (typeof url != 'string') { throw new FError('DB connection url not string') }

  const db = require('./models.js')(url)
  const Book = require('./types.js');
  
  return new Book(db)
}
const { ApiError } = require('../errors');

// Kiem tra du lieu dau vao bang Joi. source: 'body' | 'query'
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { value, error } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });
    if (error) {
      const message = error.details.map((d) => d.message).join('; ');
      return next(new ApiError(400, message));
    }
    if (source === 'query') {
      // express 4: req.query co the ghi de; giu ket qua da convert (so/enum)
      req.validatedQuery = value;
    } else {
      req.body = value;
    }
    return next();
  };
}

function getQuery(req) {
  return req.validatedQuery || req.query || {};
}

module.exports = { validate, getQuery };
